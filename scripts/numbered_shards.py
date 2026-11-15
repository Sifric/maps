#!/usr/bin/env python3
"""Numbered place shards: 0001/, 0002/, ...; at most 999 JSON records each."""
import argparse
from collections import Counter
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
MAX_RECORDS = 999


def numbered(name):
    return bool(re.fullmatch(r"[0-9]{4}", name)) and int(name) > 0


class ShardAllocator:
    """Reserve paths without creating directories or changing existing files."""
    def __init__(self, counts):
        if any(not numbered(name) or not 0 <= count <= MAX_RECORDS
               for name, count in counts.items()):
            raise ValueError("Invalid numbered shard or shard exceeds 999 records")
        self.counts = dict(counts)
        self.number = max((int(name) for name in counts), default=1)
        if counts and set(counts) != {f"{i:04d}" for i in range(1, self.number + 1)}:
            raise ValueError("Numbered shards must be contiguous, starting at 0001")

    def allocate(self, filename):
        if Path(filename).name != filename or not filename.endswith(".json"):
            raise ValueError("Expected a JSON filename, not a path")
        if self.counts.get(f"{self.number:04d}", 0) >= MAX_RECORDS:
            self.number += 1
        if self.number > 9999:
            raise ValueError("Four-digit shard capacity exhausted")
        shard = f"{self.number:04d}"
        self.counts[shard] = self.counts.get(shard, 0) + 1
        return Path(shard) / filename


def validate(data):
    counts = Counter()
    if data.exists():
        for directory in data.iterdir():
            if directory.is_symlink():
                raise ValueError(f"Refusing symlink: {directory}")
            if not directory.is_dir():
                continue  # Root metadata such as aliases.json is not a record.
            if directory.is_symlink() or not numbered(directory.name):
                raise ValueError(f"Invalid shard directory: {directory.name}")
            for path in directory.iterdir():
                if path.is_symlink() or not path.is_file() or path.suffix != ".json":
                    raise ValueError(f"Unexpected shard entry: {path}")
                counts[directory.name] += 1
            if not counts[directory.name]:
                raise ValueError(f"Empty shard: {directory.name}")
    ShardAllocator(counts)
    return dict(counts)


def verify_manifest_paths(data, manifest):
    root = data.parent.parent
    paths = [line.rstrip("\n").split("  ", 1)[1] for line in manifest.read_text().splitlines()]
    actual = {str(p.relative_to(root)) for p in data.rglob("*") if p.is_file()}
    if len(paths) != len(set(paths)) or set(paths) != actual:
        raise ValueError("Checksum inventory differs from place files; repair before importing")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=ROOT / "data/places")
    args = parser.parse_args()
    counts = validate(args.data)
    verify_manifest_paths(args.data, args.data.parent.parent / "places.sha256")
    print(f"PASS: {len(counts)} numbered shards; {sum(counts.values())} records; "
          f"maximum {max(counts.values(), default=0)} records/shard")


if __name__ == "__main__":
    main()
