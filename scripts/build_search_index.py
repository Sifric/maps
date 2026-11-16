#!/usr/bin/env python3
"""Build search from exactly the validated features used for places tiles."""
import argparse
import gzip
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("geojson", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--check", type=Path, help="Require the same search rows, independent of storage order")
    args = parser.parse_args()
    features = json.loads(args.geojson.read_text())["features"]
    rows = []
    for feature in features:
        props = feature["properties"]
        lon, lat = feature["geometry"]["coordinates"]
        rows.append([feature["id"], props["name"], lon, lat,
                     props.get("kind", "other"), props.get("subtitle", "")] +
                    ([props["label"]] if props.get("label") else []))
    if len({row[0] for row in rows}) != len(rows):
        raise ValueError("Duplicate search IDs")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(rows, ensure_ascii=False, separators=(",", ":")) + "\n"
    if args.output.suffix == ".gz":
        args.output.write_bytes(gzip.compress(serialized.encode("utf-8"), mtime=0))
    else:
        args.output.write_text(serialized)
    if args.check:
        content = args.check.read_bytes()
        if args.check.suffix == ".gz":
            content = gzip.decompress(content)
        existing = json.loads(content)
        indexed = {row[0]: row for row in existing}
        if len(indexed) != len(existing) or indexed != {row[0]: row for row in rows}:
            raise ValueError("Committed search data differs from validated places")
        print("PASS: search rows match exactly, independent of shard storage order")
    print(f"Search index: {len(rows)} validated places")


if __name__ == "__main__":
    main()
