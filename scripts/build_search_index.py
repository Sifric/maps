#!/usr/bin/env python3
"""Build search from exactly the validated features used for places tiles."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("geojson", type=Path)
    parser.add_argument("output", type=Path)
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
    args.output.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Search index: {len(rows)} validated places")


if __name__ == "__main__":
    main()
