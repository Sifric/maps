#!/usr/bin/env python3
"""Import named, deduplicated POIs from our released basemap into data/places.

Dry-run by default. Existing records are never overwritten. Vector IDs are
provenance identifiers, not assumed to be OSM node IDs. No contacts are copied.
"""
import argparse
from collections import Counter, defaultdict
from difflib import SequenceMatcher
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import unicodedata

from numbered_shards import ShardAllocator, validate, verify_manifest_paths

ROOT = Path(__file__).resolve().parent.parent


def normalized(name):
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", name).casefold()))


def aliases_for(names):
    aliases = {normalized(n) for n in names if normalized(n)}
    # Mixed-script names often repeat the same business in English and Tamil/Sinhala.
    for name in names:
        latin = " ".join(re.findall(r"[A-Za-z0-9]+", name))
        if len(latin) >= 8:
            aliases.add(normalized(latin))
    return aliases


def distance(a, b):
    return math.hypot((a[0] - b[0]) * math.cos(math.radians((a[1] + b[1]) / 2)),
                      a[1] - b[1]) * 111320


def category(props):
    value = props.get("subclass") or props.get("class") or "Other"
    return {"bus_stop": "Bus stop", "bus_station": "Bus station",
            "station": "Railway station", "worship": "Place of worship",
            "post": "Post office", "grocery": "Grocery store",
            "lodging": "Hotel", "town_hall": "Town hall",
            "railway": "Railway station", "fast_food": "Fast food restaurant",
            "fuel": "Fuel station"}.get(value, value.replace("_", " ").capitalize())


def collect_features(value):
    if isinstance(value, dict):
        if value.get("type") == "Feature":
            yield value
        else:
            for child in value.values():
                yield from collect_features(child)
    elif isinstance(value, list):
        for child in value:
            yield from collect_features(child)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    initial_shards = validate(ROOT / "data/places")
    verify_manifest_paths(ROOT / "data/places", ROOT / "places.sha256")
    checksum_before = (ROOT / "places.sha256").read_bytes()
    allocator = ShardAllocator(initial_shards)
    record_ids = set()
    digest = hashlib.file_digest(args.archive.open("rb"), "sha256").hexdigest()
    decoded = json.loads(subprocess.check_output([
        "tippecanoe-decode", "--layer=poi", "--minimum-zoom=14", "--maximum-zoom=14",
        str(args.archive)], stderr=subprocess.DEVNULL))
    grid = defaultdict(list)
    source_ids = set()
    counts = Counter()
    def cell(xy):
        return (math.floor(xy[0] / .002), math.floor(xy[1] / .002))
    def add(xy, aliases):
        grid[cell(xy)].append((xy, aliases_for(aliases)))
    for path in sorted((ROOT / "data/places").glob("????/*.json")):
        rec = json.loads(path.read_text())
        record_ids.add(str(rec.get("id", path.name)))
        co = rec.get("coordinates", {})
        xy = (co.get("longitude"), co.get("latitude"))
        if all(isinstance(v, (int, float)) and math.isfinite(v) for v in xy):
            add(xy, [rec.get("name", ""), *rec.get("source", {}).get("names", [])])
        if rec.get("source", {}).get("provider") == "OpenStreetMap":
            source_ids.add(str(rec["source"]["vector_feature_id"]))
    unique = {}
    for feature in collect_features(decoded):
        if feature.get("id") is None:
            counts["missing_vector_id"] += 1
            continue
        unique.setdefault(str(feature["id"]), feature)
    decisions = []
    writes = []
    for fid, feature in sorted(unique.items()):
        if not fid.isdecimal():
            raise ValueError("Vector feature ID must be numeric")
        props = feature["properties"]
        names = [str(props[k]).strip() for k in ("name", "name_en", "name:latin", "name_int")
                 if isinstance(props.get(k), str) and props[k].strip()]
        if not names:
            counts["unnamed_skipped"] += 1
            continue
        if feature["geometry"]["type"] != "Point":
            raise ValueError("POI import accepts points only")
        xy = feature["geometry"]["coordinates"]
        if not (79.5 <= xy[0] <= 82 and 5.9 <= xy[1] <= 9.9):
            counts["outside_sri_lanka_bounds"] += 1
            continue
        if fid in source_ids:
            counts["already_imported"] += 1
            continue
        aliases = aliases_for(names)
        cx, cy = cell(xy)
        reason = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for point, existing in grid[(cx + dx, cy + dy)]:
                    metres = distance(xy, point)
                    if metres > 150:
                        continue
                    if aliases & existing:
                        reason = "same_name_nearby"
                    elif metres < 75 and any(
                        len(a) > 5 and len(b) > 5 and
                        SequenceMatcher(None, a, b).ratio() >= .88
                        for a in aliases for b in existing):
                        reason = "possible_duplicate_skipped"
                    if reason:
                        break
                if reason:
                    break
            if reason:
                break
        if reason:
            counts[reason] += 1
            decisions.append({"vector_feature_id": fid, "reason": reason})
            continue
        rid = "osm-poi-" + fid
        if rid in record_ids:
            counts["already_imported"] += 1
            continue
        path = ROOT / "data/places" / allocator.allocate(rid + ".json")
        record_ids.add(rid)
        if path.exists():
            raise ValueError(f"Refusing to overwrite {path.relative_to(ROOT)}")
        record = {"id": rid, "name": names[0],
                  "coordinates": {"latitude": xy[1], "longitude": xy[0]},
                  "categories": [category(props)],
                  "source": {"provider": "OpenStreetMap", "layer": "poi",
                             "vector_feature_id": fid, "archive_sha256": digest,
                             "class": props.get("class"), "subclass": props.get("subclass"),
                             "names": list(dict.fromkeys(names))}}
        writes.append((path, (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode()))
        add(xy, names)
        counts["new_places"] += 1
    # Validate everything before creating any records. Never alter an existing one.
    if args.apply:
        if ((ROOT / "places.sha256").read_bytes() != checksum_before
                or validate(ROOT / "data/places") != initial_shards):
            raise ValueError("Shard layout changed while planning import")
        with (ROOT / "places.sha256").open("a") as checksums:
            for path, data in writes:
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("xb") as output:
                    output.write(data)
                checksums.write(f"{hashlib.sha256(data).hexdigest()}  {path.relative_to(ROOT)}\n")
        validate(ROOT / "data/places")
        verify_manifest_paths(ROOT / "data/places", ROOT / "places.sha256")
    report = {"unique_vector_pois": len(unique), "applied": args.apply,
              "counts": dict(counts), "skipped_duplicates": decisions, "archive_sha256": digest}
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "build/osm-import-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "skipped_duplicates"}, indent=2))


if __name__ == "__main__":
    main()
