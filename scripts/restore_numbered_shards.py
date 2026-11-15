#!/usr/bin/env python3
"""Safely move the imported OSM records into numbered shards. Dry-run first.

Existing non-OSM records and root metadata stay at their original paths. A
persisted plan and checksum backup permit resuming an interrupted migration.
Files are renamed, never rewritten; empty old directories are archived locally.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re

from numbered_shards import ROOT, ShardAllocator, numbered, validate


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def safe_path(root, name):
    relative = Path(name)
    path = root / relative
    if (relative.parts[:2] != ("data", "places") or relative.is_absolute()
            or ".." in relative.parts or not path.resolve().is_relative_to(root)):
        raise ValueError(f"Unsafe migration path: {name}")
    return path


def make_plan(root):
    records, imported, counts = [], [], Counter()
    for directory in (root / "data/places").iterdir():
        if directory.is_dir():
            if directory.is_symlink() or not re.fullmatch(r"[0-9a-f]{4}", directory.name):
                raise ValueError(f"Unexpected shard directory: {directory}")
            if any(p.is_symlink() or not p.is_file() or p.suffix != ".json"
                   for p in directory.iterdir()):
                raise ValueError(f"Unexpected entry in shard: {directory}")
    for path in sorted((root / "data/places").glob("????/*.json")):
        if path.is_symlink():
            raise ValueError(f"Refusing symlink: {path}")
        record = {"old": str(path.relative_to(root)), "sha256": digest(path)}
        records.append(record)
        if re.fullmatch(r"osm-poi-[0-9]+\.json", path.name):
            source = json.loads(path.read_text())
            if source.get("source", {}).get("provider") != "OpenStreetMap":
                raise ValueError("Imported record lacks OpenStreetMap provenance")
            imported.append((path.name, record))
        else:
            if not numbered(path.parent.name):
                raise ValueError("Unexpected non-OSM record outside original numbered shards")
            counts[path.parent.name] += 1
    if len({Path(r["old"]).name for r in records}) != len(records):
        raise ValueError("Duplicate record filenames; refusing migration")
    allocator = ShardAllocator(counts)
    for filename, record in sorted(imported):
        record["new"] = str(Path("data/places") / allocator.allocate(filename))
    for record in records:
        record.setdefault("new", record["old"])
    metadata = [{"path": str(p.relative_to(root)), "sha256": digest(p)}
                for p in (root / "data/places").iterdir() if p.is_file()]
    lines = (root / "places.sha256").read_text().splitlines(keepends=True)
    expected = {r["old"]: r["sha256"] for r in records}
    expected.update({r["path"]: r["sha256"] for r in metadata})
    listed = {}
    for line in lines:
        checksum, path = line.rstrip("\n").split("  ", 1)
        if path in listed:
            raise ValueError("Duplicate checksum entry")
        listed[path] = checksum
    if listed != expected:
        raise ValueError("Current file inventory does not match places.sha256")
    return {"root": str(root), "records": records, "metadata": metadata,
            "checksum_lines": lines, "shards": allocator.counts}


def apply_plan(root, plan, journal):
    if plan["root"] != str(root):
        raise ValueError("Plan belongs to a different repository")
    # Check every endpoint before moving anything. This also supports resuming.
    endpoints = set()
    for record in plan["records"]:
        old, new = (safe_path(root, record[k]) for k in ("old", "new"))
        if old != new and (old.name != new.name or not re.fullmatch(r"osm-poi-[0-9]+\.json", old.name) or not numbered(new.parent.name)):
            raise ValueError("Plan may only relocate imported OSM records without renaming them")
        present = [p for p in {old, new} if p.exists()]
        if len(present) != 1 or present[0].is_symlink() or digest(present[0]) != record["sha256"]:
            raise ValueError(f"Record changed or migration endpoints conflict: {record['old']}")
        endpoints.add(present[0])
    actual_paths = set((root / "data/places").glob("????/*.json"))
    if actual_paths != endpoints:
        raise ValueError("Record inventory changed after planning")
    for metadata in plan["metadata"]:
        if digest(safe_path(root, metadata["path"])) != metadata["sha256"]:
            raise ValueError("Root metadata changed")
    mapping = {r["old"]: r["new"] for r in plan["records"]}
    updated_lines = []
    for line in plan["checksum_lines"]:
        checksum, path = line.rstrip("\n").split("  ", 1)
        updated_lines.append(f"{checksum}  {mapping.get(path, path)}\n")
    updated = "".join(updated_lines)
    current = (root / "places.sha256").read_text()
    if current not in ("".join(plan["checksum_lines"]), updated):
        raise ValueError("Checksum file changed since plan was created")
    with journal.open("a") as log:
        for record in plan["records"]:
            old, new = (safe_path(root, record[k]) for k in ("old", "new"))
            if old != new and old.exists():
                if new.exists():
                    raise ValueError(f"Refusing overwrite: {new}")
                new.parent.mkdir(parents=True, exist_ok=True)
                old.rename(new)
                log.write(json.dumps({"old": record["old"], "new": record["new"]}) + "\n")
    # Verify all bytes and all paths before updating the checksum manifest.
    actual = {str(p.relative_to(root)): digest(p)
              for p in (root / "data/places").glob("????/*.json")}
    if actual != {r["new"]: r["sha256"] for r in plan["records"]}:
        raise ValueError("Post-migration record inventory mismatch; retain plan and journal")
    archive = root / ".cache/empty-place-shards"
    for directory in list((root / "data/places").iterdir()):
        if directory.is_dir() and next(directory.iterdir(), None) is None:
            archive.mkdir(parents=True, exist_ok=True)
            target = archive / directory.name
            if target.exists():
                raise ValueError(f"Archive destination exists: {target}")
            directory.rename(target)
    counts = validate(root / "data/places")
    if counts != plan["shards"]:
        raise ValueError("Final shard counts do not match plan")
    temporary = journal.with_suffix(".checksums-next.txt")
    with temporary.open("w") as output:
        output.write(updated)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(root / "places.sha256")
    for metadata in plan["metadata"]:
        if digest(safe_path(root, metadata["path"])) != metadata["sha256"]:
            raise ValueError("Root metadata changed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    if args.plan.exists():
        plan = json.loads(args.plan.read_text())
    else:
        plan = make_plan(root)
        args.plan.parent.mkdir(parents=True, exist_ok=True)
        with args.plan.open("x") as output:
            json.dump(plan, output, indent=2)
        args.plan.with_suffix(".checksums-before.txt").write_text("".join(plan["checksum_lines"]))
    if args.apply:
        apply_plan(root, plan, args.plan.with_suffix(".journal.jsonl"))
    print(json.dumps({"applied": args.apply, "records": len(plan["records"]),
                      "moved": sum(r["old"] != r["new"] for r in plan["records"]),
                      "original_paths_preserved": sum(r["old"] == r["new"] for r in plan["records"]),
                      "numbered_shards": len(plan["shards"]),
                      "maximum_records": max(plan["shards"].values()),
                      "last_shard": sorted(plan["shards"].items())[-1]}, indent=2))


if __name__ == "__main__":
    main()
