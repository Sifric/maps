#!/usr/bin/env python3
"""Build places PMTiles from data/places/ JSON files.

Pipeline
--------
1.  Read & validate every ``data/places/<shard>/*.json``
2.  Filter out institutional codes listed in ``config/school_codes.json``
3.  Map primary category → super-group → (priority, min_zoom)
4.  Emit ``build/places.geojson``
5.  Run **tippecanoe** → ``build/places.pmtiles``
6.  Write ``build/manifest.json``
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── paths ──────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data" / "places"
BUILD_DIR = ROOT / "build"
CODES_FILE = ROOT / "config" / "school_codes.json"

# ── Sri Lanka bounding box ─────────────────────────────────────────────
MIN_LAT, MAX_LAT = 5.9, 9.9
MIN_LON, MAX_LON = 79.5, 82.0

# ── Institutional codes (loaded from config) ──────────────────────────
with open(CODES_FILE) as _f:
    SCHOOL_CODES: set[str] = set(json.load(_f)["codes"])

# ── Category → (priority, min_zoom) via keyword substring matching ────
# Lower priority number = more important.  If a category contains any
# keyword from a group, that group's (priority, min_zoom) is returned.
GROUPS: list[tuple[int, int, list[str]]] = [
    # Priority 1 – major infrastructure (min_zoom 5)
    (1, 5, [
        "hospital", "airport", "government", "university",
        "embassy", "military", "parliament", "ministry",
    ]),
    # Priority 2 – schools / community services (min_zoom 7)
    (2, 7, [
        "educational institution", "school", "college", "academy",
        "institute", "bank", "supermarket", "police", "fire station",
        "place of worship", "temple", "mosque", "church", "kovil",
        "cathedral", "synagogue", "hindu temple", "buddhist temple",
        "bus station", "train station", "railway station",
        "library", "courthouse", "court house",
    ]),
    # Priority 3 – common amenities (min_zoom 9)
    (3, 9, [
        "restaurant", "hotel", "motel", "pharmacy", "gas station",
        "fuel", "petrol", "post office", "clinic", "medical center",
        "medical centre", "shopping mall", "shopping center",
        "shopping centre", "market", "resort", "inn", "guest house",
        "guesthouse", "atm", "stadium", "park", "museum",
        "zoo", "cinema", "theater", "theatre",
    ]),
    # Priority 4 – shops & services (min_zoom 11)
    (4, 11, [
        "store", "shop", "gym", "fitness", "salon", "beauty",
        "repair", "dentist", "doctor", "lawyer", "attorney",
        "office", "agency", "bakery", "cafe", "café", "coffee",
        "laundry", "tailor", "barber", "spa", "studio",
        "garage", "mechanic", "warehouse", "factory", "company",
        "contractor", "plumber", "electrician", "carpenter",
        "photographer", "printer", "florist", "pet",
    ]),
    # Everything else falls through → priority 5, min_zoom 13
]

# Use only existing GROUPS keywords; preserve their order for classification.
CATEGORY_RANK_WEIGHT = {
    **{keyword: 100 for _, _, keywords in GROUPS for keyword in keywords},
    **dict.fromkeys([
        "airport", "government", "embassy", "military", "parliament", "ministry",
        "bus station", "train station", "railway station", "courthouse", "court house",
        "museum", "zoo", "stadium", "park", "police", "fire station",
    ], 400),
    **dict.fromkeys([
        "hospital", "university", "educational institution", "school", "college",
        "academy", "institute", "place of worship", "temple", "mosque", "church",
        "kovil", "cathedral", "synagogue", "hindu temple", "buddhist temple",
        "clinic", "medical center", "medical centre", "pharmacy", "doctor", "dentist",
    ], 300),
    **dict.fromkeys([
        "restaurant", "supermarket", "shopping mall", "shopping center", "shopping centre",
        "market", "store", "shop", "bakery", "cafe", "café", "coffee",
    ], 200),
}


def rank_score(category: str, name: str) -> int:
    """Score existing category keywords, with a small mixed-language name bonus."""
    low = category.lower()
    score = max((CATEGORY_RANK_WEIGHT[keyword]
                 for _, _, keywords in GROUPS for keyword in keywords if keyword in low),
                default=100)
    english = any("a" <= character.lower() <= "z" for character in name)
    local = any("\u0b80" <= character <= "\u0bff" or
                "\u0d80" <= character <= "\u0dff" for character in name)
    return score + int(english and local)


def classify(category: str) -> tuple[int, int]:
    """Return ``(priority, min_zoom)`` for a *real* category string."""
    low = category.lower()
    for pri, mz, keywords in GROUPS:
        if any(kw in low for kw in keywords):
            return pri, mz
    return 5, 13


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    BUILD_DIR.mkdir(exist_ok=True)

    files = sorted(glob.glob(str(DATA_DIR / "????" / "*.json")))
    print(f"Found {len(files)} place files")

    features: list[dict] = []
    ranking: list[tuple[int, str, int]] = []
    code_warnings: list[str] = []
    ignored_codes: dict[str, int] = {}
    dropped: list[dict] = []
    skipped_name = 0
    total = 0

    for fpath in files:
        with open(fpath) as f:
            rec = json.load(f)

        total += 1
        rid = rec.get("id", os.path.basename(fpath))

        # ── validate name ─────────────────────────────────────────────
        name = (rec.get("name") or "").strip()
        if not name:
            skipped_name += 1
            dropped.append({"id": rid, "reason": "empty_name"})
            continue

        # ── validate coordinates ──────────────────────────────────────
        coords = rec.get("coordinates", {})
        lat = coords.get("latitude")
        lon = coords.get("longitude")
        if lat is None or lon is None:
            dropped.append({"id": rid, "reason": "missing_coords"})
            continue
        if not (MIN_LAT <= lat <= MAX_LAT and MIN_LON <= lon <= MAX_LON):
            dropped.append({
                "id": rid,
                "reason": "out_of_bounds",
                "lat": lat,
                "lon": lon,
            })
            continue

        # ── process categories ────────────────────────────────────────
        raw_cats = rec.get("categories", [])
        real_cats: list[str] = []
        for c in raw_cats:
            if c in SCHOOL_CODES:
                ignored_codes[c] = ignored_codes.get(c, 0) + 1
                code_warnings.append(
                    f"WARNING: Ignored institutional code '{c}' in {rid}"
                )
            else:
                real_cats.append(c)

        primary = real_cats[0] if real_cats else "Other"
        pri, mz = classify(primary)

        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat],
            },
            "properties": {
                "name": name,
                "category": primary,
                "min_zoom": mz,
                "priority": pri,
            },
            "tippecanoe": {
                "minzoom": mz,
            },
        })
        ranking.append((-rank_score(primary, name), str(rid), len(features) - 1))

    # Keep score/language/id ordering, but assign ranks from the base category score.
    for _, _, index in sorted(ranking):
        properties = features[index]["properties"]
        base_score = rank_score(properties["category"], "")
        rank = {400: 1, 300: 2, 200: 3, 100: 4}[base_score]
        features[index]["properties"]["rank"] = rank
        features[index]["properties"]["min_zoom"] = rank + 6
        features[index]["tippecanoe"]["minzoom"] = rank + 6
    rank_counts = {rank: sum(f["properties"]["rank"] == rank for f in features)
                   for rank in range(1, 5)}
    print("Rank counts:", rank_counts)
    if any(count == 0 for count in rank_counts.values()):
        raise ValueError("A score-based rank has zero features")

    # ── write GeoJSON ─────────────────────────────────────────────────
    geojson_path = BUILD_DIR / "places.geojson"
    with open(geojson_path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    print(f"Wrote {len(features)} features → {geojson_path}")

    # ── log warnings ──────────────────────────────────────────────────
    if code_warnings:
        print(f"\n⚠  {len(code_warnings)} institutional-code warnings "
              f"({len(ignored_codes)} distinct codes):")
        for w in code_warnings[:30]:
            print(f"  {w}")
        if len(code_warnings) > 30:
            print(f"  … and {len(code_warnings) - 30} more")

    print(f"\nSkipped: {skipped_name} empty-name, "
          f"{len(dropped) - skipped_name} bad-coords, "
          f"{len(dropped)} total dropped")

    # ── tippecanoe → separate tier archives → one places layer ─────────
    tier_dir = BUILD_DIR / "tiers"
    tier_dir.mkdir(exist_ok=True)
    tier_archives = []
    for tier, rank, minimum_zoom in (("a", 1, 0), ("b", 2, 9),
                                     ("c", 3, 11), ("d", 4, 13)):
        tier_features = [feature for feature in features
                         if feature["properties"]["rank"] == rank]
        print(f"Tier {tier.upper()}: {len(tier_features)} features; zooms {minimum_zoom}–14")
        if not tier_features:
            raise ValueError(f"Tier {tier.upper()} has no features")
        # Tier archive flags are the sole zoom control. Keep ordinary properties
        # (including min_zoom), but remove reserved Tippecanoe zoom metadata.
        tier_features = [
            {
                **{key: value for key, value in feature.items()
                   if key not in ("tippecanoe", "minzoom", "maxzoom", "properties")},
                "properties": {key: value for key, value in feature["properties"].items()
                               if key not in ("tippecanoe", "minzoom", "maxzoom")},
            }
            for feature in tier_features
        ]
        tier_geojson = tier_dir / f"tier_{tier}.geojson"
        with tier_geojson.open("w") as output:
            json.dump({"type": "FeatureCollection", "features": tier_features}, output)
        tier_archive = tier_dir / f"tier_{tier}.pmtiles"
        cmd = [
            "tippecanoe",
            "-o", str(tier_archive),
            "-z", "14",
            "-Z", str(minimum_zoom),
            "-l", "places",
            "--no-feature-limit",
            "--no-tile-size-limit",
            "--force",
            "--drop-densest-as-needed",
            "--maximum-zoom=14",
            str(tier_geojson),
        ]
        print(f"\nRunning: {' '.join(cmd)}", flush=True)
        subprocess.run(cmd, check=True)
        tier_archives.append(tier_archive)

    pmtiles_path = BUILD_DIR / "places.pmtiles"
    cmd = ["tile-join", "-o", str(pmtiles_path), "--force",
           *(str(path) for path in tier_archives)]
    print(f"\nRunning: {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True)
    print(f"✓ Created {pmtiles_path}")

    # ── manifest ──────────────────────────────────────────────────────
    pmtiles_sha = sha256_file(pmtiles_path)
    manifest = {
        "file": "places.pmtiles",
        "sha256": pmtiles_sha,
        "sha8": pmtiles_sha[:8],
        "record_count": len(features),
        "total_input": total,
        "dropped": dropped,
        "skipped_empty_name": skipped_name,
        "ignored_codes": ignored_codes,
        "ignored_codes_total": sum(ignored_codes.values()),
        "bounds_decision": {
            "lon": [MIN_LON, MAX_LON],
            "lat": [MIN_LAT, MAX_LAT],
            "records_in_79.3_79.5": 0,
            "note": "No records between lon 79.3-79.5. Bounds set to 79.5-82.0 as agreed.",
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "zooms": "0-14",
    }
    manifest_path = BUILD_DIR / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Wrote {manifest_path}")
    print(f"SHA256: {pmtiles_sha}")
    print(f"SHA8:   {pmtiles_sha[:8]}")


if __name__ == "__main__":
    main()
