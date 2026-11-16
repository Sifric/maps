#!/usr/bin/env python3
"""Safely merge a supplied all_places.json ZIP into numbered place shards.

Dry-run is the default. Records with missing/invalid coordinates or outside
the current Sri Lanka build bounds are skipped. Nearby same-name records are
merged into the existing record. Contact phone fields are not copied.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unicodedata
import zipfile

from numbered_shards import ShardAllocator, validate, verify_manifest_paths

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "places"
MANIFEST = ROOT / "places.sha256"
MIN_LAT, MAX_LAT = 5.9, 9.9
MIN_LON, MAX_LON = 79.5, 82.0
CELL = 0.002


def normalize(value: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", value).casefold()))


def aliases(name: str, extra=()) -> set[str]:
    values = [name, *extra]
    found = {normalize(value) for value in values
             if isinstance(value, str) and normalize(value)}
    for value in values:
        if isinstance(value, str):
            latin = " ".join(re.findall(r"[A-Za-z0-9]+", value))
            if len(latin) >= 8:
                found.add(normalize(latin))
    return found


def coordinates(record: dict):
    value = record.get("coordinates")
    if not isinstance(value, dict):
        return None, "missing_coordinates"
    lat, lon = value.get("latitude"), value.get("longitude")
    if lat is None or lon is None:
        return None, "missing_coordinates"
    if (isinstance(lat, bool) or isinstance(lon, bool)
            or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float))
            or not math.isfinite(lat) or not math.isfinite(lon)
            or not -90 <= lat <= 90 or not -180 <= lon <= 180):
        return None, "invalid_coordinates"
    if not MIN_LAT <= lat <= MAX_LAT or not MIN_LON <= lon <= MAX_LON:
        return None, "outside_bounds"
    return (lon, lat), "ok"


def cell(point):
    return math.floor(point[0] / CELL), math.floor(point[1] / CELL)


def within_dedupe_distance(a, b):
    return math.hypot((a[0] - b[0]) * math.cos(math.radians((a[1] + b[1]) / 2)),
                      a[1] - b[1]) * 111320 <= 150


class NearbyNameIndex:
    def __init__(self):
        self.cells = defaultdict(lambda: defaultdict(list))

    def add(self, point, names, entry):
        location = cell(point)
        for name in names:
            self.cells[location][name].append((point, entry))

    def contains(self, point, names):
        cx, cy = cell(point)
        best = None
        best_distance = float("inf")
        for name in names:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other, entry in self.cells.get((cx + dx, cy + dy), {}).get(name, ()):
                        if within_dedupe_distance(point, other):
                            distance = math.hypot(point[0] - other[0], point[1] - other[1])
                            if distance < best_distance:
                                best, best_distance = entry, distance
        return best


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_checksums():
    subprocess.run(["sha256sum", "--quiet", "-c", str(MANIFEST)], cwd=ROOT,
                   check=True, stdout=subprocess.DEVNULL)
    verify_manifest_paths(DATA, MANIFEST)


def make_record(source: dict, index: int, point, archive_hash: str):
    name = source["name"].strip()
    categories = source.get("categories")
    categories = [item.strip() for item in categories
                  if isinstance(item, str) and item.strip()] if isinstance(categories, list) else []
    if not categories:
        categories = ["Other"]
    stable_key = "\0".join((normalize(name), format(point[1], ".6f"), format(point[0], ".6f")))
    record_id = "catalog-place-" + hashlib.sha256(stable_key.encode("utf-8")).hexdigest()[:32]
    record = {
        "id": record_id,
        "name": name,
        "coordinates": {"latitude": point[1], "longitude": point[0]},
        "categories": categories,
        "source": {"archive_sha256": archive_hash, "record_index": index},
    }
    for key in ("address", "hours", "business_status", "alternate_addresses"):
        value = source.get(key)
        if value not in (None, "", []):
            record[key] = value
    return record


def merge_source_data(target: dict, incoming: dict, archive_hash: str):
    """Refresh non-contact fields while keeping the existing id/name/location."""
    categories = target.get("categories")
    if not isinstance(categories, list):
        categories = target["categories"] = []
    known = {normalize(item) for item in categories if isinstance(item, str)}
    incoming_categories = incoming.get("categories", [])
    if not isinstance(incoming_categories, list):
        incoming_categories = []
    for item in incoming_categories:
        if isinstance(item, str) and item.strip() and normalize(item) not in known:
            categories.append(item.strip())
            known.add(normalize(item))
    address = incoming.get("address")
    if isinstance(address, str) and address.strip():
        address = address.strip()
        if not target.get("address"):
            target["address"] = address
        elif target["address"] != address:
            alternates = target.get("alternate_addresses")
            if not isinstance(alternates, list):
                alternates = target["alternate_addresses"] = []
            if address not in alternates:
                alternates.append(address)
    for key in ("hours", "business_status"):
        value = incoming.get(key)
        if value not in (None, "", []):
            target[key] = value
    metadata = target.setdefault("source", {})
    if not isinstance(metadata, dict):
        metadata = target["source"] = {}
    source_names = metadata.setdefault("names", [])
    if not isinstance(source_names, list):
        source_names = metadata["names"] = []
    if incoming.get("name") and incoming["name"] != target.get("name") and incoming["name"] not in source_names:
        source_names.append(incoming["name"])
    updates = metadata.setdefault("archive_updates", [])
    if not isinstance(updates, list):
        updates = metadata["archive_updates"] = []
    if archive_hash not in updates:
        updates.append(archive_hash)


def record_bytes(record):
    return (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def plan_archive(archive: Path, plan_path: Path):
    verify_checksums()
    base_manifest_hash = file_hash(MANIFEST)
    base_counts = validate(DATA)
    index = NearbyNameIndex()
    original_hashes = {}
    for path in sorted(DATA.glob("????/*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        point, status = coordinates(record)
        if point:
            metadata = record.get("source")
            old_names = metadata.get("names", []) if isinstance(metadata, dict) else []
            if not isinstance(old_names, (list, tuple)):
                old_names = []
            relative = str(path.relative_to(ROOT))
            original_hashes[relative] = file_hash(path)
            index.add(point, aliases(record.get("name", ""), old_names), {
                "record": record, "path": relative, "action": "update",
            })

    archive_hash = file_hash(archive)
    with zipfile.ZipFile(archive) as zf:
        names = [name for name in zf.namelist() if not name.endswith("/")]
        if len(names) != 1 or not names[0].lower().endswith(".json"):
            raise ValueError("Expected one JSON file in the ZIP archive")
        rows = json.load(zf.open(names[0]))
    if not isinstance(rows, list):
        raise ValueError("Archive JSON must contain a list of places")

    allocator = ShardAllocator(base_counts)
    counts = Counter()
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    header = {
        "type": "plan",
        "archive_sha256": archive_hash,
        "base_manifest_sha256": base_manifest_hash,
        "base_record_count": sum(base_counts.values()),
        "input_count": len(rows),
    }
    planned_ids = set()
    planned_records = {}
    updated_records = {}
    with plan_path.open("x", encoding="utf-8") as output:
        output.write(json.dumps(header) + "\n")
        for row_index, source in enumerate(rows):
            point, status = coordinates(source)
            if point is None:
                counts[status] += 1
                continue
            name = source.get("name")
            if not isinstance(name, str) or not name.strip():
                counts["missing_name"] += 1
                continue
            names = aliases(name.strip())
            matched = index.contains(point, names)
            if matched:
                before = json.dumps(matched["record"], sort_keys=True, ensure_ascii=False)
                merge_source_data(matched["record"], source, archive_hash)
                index.add(point, names, matched)
                if matched["action"] == "update":
                    counts["matched_existing"] += 1
                else:
                    counts["duplicate_within_archive"] += 1
                if before != json.dumps(matched["record"], sort_keys=True, ensure_ascii=False):
                    counts["records_refreshed"] += 1
                    if matched["action"] == "update":
                        updated_records[matched["path"]] = matched
                continue
            record = make_record(source, row_index, point, archive_hash)
            if record["id"] in planned_ids:
                counts["duplicate_stable_id"] += 1
                continue
            planned_ids.add(record["id"])
            relative = allocator.allocate(record["id"] + ".json")
            target = str(Path("data/places") / relative)
            entry = {"record": record, "path": target, "action": "create"}
            planned_records[target] = entry
            index.add(point, names, entry)
            counts["accepted"] += 1
        for path, entry in sorted(planned_records.items()):
            content = record_bytes(entry["record"])
            output.write(json.dumps({
                "action": "create", "path": path,
                "sha256": hashlib.sha256(content).hexdigest(),
                "record": entry["record"],
            }, ensure_ascii=False, separators=(",", ":")) + "\n")
        for path, entry in sorted(updated_records.items()):
            record = entry["record"]
            content = record_bytes(record)
            output.write(json.dumps({
                "action": "update", "path": path,
                "before_sha256": original_hashes[path],
                "sha256": hashlib.sha256(content).hexdigest(),
                "record": record,
            }, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps({
        "archive_sha256": archive_hash,
        "input_count": len(rows),
        "counts": dict(counts),
        "new_records": counts["accepted"],
        "existing_records_to_update": len(updated_records),
        "final_records": sum(base_counts.values()) + counts["accepted"],
        "final_shards": len(allocator.counts),
        "plan": str(plan_path),
        "plan_bytes": plan_path.stat().st_size,
    }, indent=2))


def apply_plan(archive: Path, plan_path: Path):
    if not plan_path.is_file():
        raise ValueError("Plan file is missing; run the dry-run first")
    with plan_path.open(encoding="utf-8") as source:
        header = json.loads(next(source))
        if header.get("type") != "plan" or header.get("archive_sha256") != file_hash(archive):
            raise ValueError("Plan does not match the supplied archive")
        rows = [json.loads(line) for line in source]
    if header.get("base_manifest_sha256") != file_hash(MANIFEST):
        if all((ROOT / row["path"]).is_file()
               and file_hash(ROOT / row["path"]) == row["sha256"] for row in rows):
            print(json.dumps({"already_applied": True, "records": len(rows)}, indent=2))
            return
        raise ValueError("The place manifest changed after planning")

    # Preflight all targets and bytes before making a record. This also makes
    # rerunning --apply safe after an interrupted write.
    targets = set()
    expected_hashes = {}
    for row in rows:
        path = (ROOT / row["path"]).resolve()
        if DATA.resolve() not in path.parents or path.suffix != ".json":
            raise ValueError("Unsafe plan path")
        rel = str(path.relative_to(ROOT))
        if rel in targets:
            raise ValueError("Duplicate target in plan")
        targets.add(rel)
        content = record_bytes(row["record"])
        digest = hashlib.sha256(content).hexdigest()
        if digest != row["sha256"]:
            raise ValueError("Plan record checksum mismatch")
        expected_hashes[rel] = (digest, content, row["action"], row.get("before_sha256"))
        if row["action"] == "create" and path.exists() and file_hash(path) != digest:
            raise ValueError(f"Refusing to overwrite a different record: {rel}")
        if row["action"] == "update" and path.exists():
            actual_hash = file_hash(path)
            if actual_hash not in (digest, row.get("before_sha256")):
                raise ValueError(f"Refusing to overwrite a changed record: {rel}")

    # Validate unchanged baseline paths and permit only already-written plan
    # targets as extras, for safe resume after an interrupted append.
    manifest_rows = {}
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        digest, rel = line.split("  ", 1)
        if rel in manifest_rows or file_hash(ROOT / rel) != digest:
            raise ValueError("Existing checksum manifest is invalid")
        manifest_rows[rel] = digest
    actual = {str(path.relative_to(ROOT)) for path in DATA.rglob("*") if path.is_file()}
    extras = actual - set(manifest_rows)
    if not extras <= {rel for rel, values in expected_hashes.items() if values[2] == "create"} or set(manifest_rows) - actual:
        raise ValueError("Place files changed outside this import plan")
    for rel in extras:
        if file_hash(ROOT / rel) != expected_hashes[rel][0]:
            raise ValueError("An unmanifested file does not match the import plan")

    written = 0
    updated = 0
    for rel, (digest, content, action, before_hash) in expected_hashes.items():
        path = ROOT / rel
        if action == "create" and path.exists():
            continue
        if action == "update" and path.exists() and file_hash(path) == digest:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        if action == "create":
            with path.open("xb") as output:
                output.write(content)
            written += 1
        else:
            with tempfile.NamedTemporaryFile(dir=ROOT / "build", prefix="place-update-", delete=False) as output:
                temporary_record = Path(output.name)
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            if file_hash(path) != before_hash:
                raise ValueError(f"Record changed during update: {rel}")
            os.replace(temporary_record, path)
            updated += 1

    # Rebuild the checksum manifest atomically after every record exists.
    entries = []
    for path in sorted(DATA.rglob("*.json")):
        entries.append(f"{file_hash(path)}  {path.relative_to(ROOT)}\n")
    fd, temporary = tempfile.mkstemp(prefix="places.sha256.", dir=MANIFEST.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.writelines(entries)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, MANIFEST)
    except Exception:
        raise
    shard_counts = validate(DATA)
    verify_checksums()
    verify_manifest_paths(DATA, MANIFEST)
    print(json.dumps({
        "applied": written,
        "updated": updated,
        "final_records": sum(shard_counts.values()),
        "checksum_entries": len(entries),
        "final_shards": len(shard_counts),
        "maximum_records_per_shard": max(shard_counts.values(), default=0),
    }, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--plan", type=Path, default=ROOT / "build/places-archive-sync-plan.jsonl")
    parser.add_argument("--apply", action="store_true", help="write the already-created plan")
    args = parser.parse_args()
    if args.apply:
        apply_plan(args.archive, args.plan)
    else:
        plan_archive(args.archive, args.plan)


if __name__ == "__main__":
    main()
