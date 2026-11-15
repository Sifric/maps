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
from collections import defaultdict, deque
import hashlib
import json
import math
import os
import re
import unicodedata
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

KEYWORD_KIND = {
    **dict.fromkeys(["restaurant", "bakery", "cafe", "café", "coffee"], "food"),
    **dict.fromkeys(["supermarket", "shopping mall", "shopping center", "shopping centre",
                     "market", "store", "shop", "florist", "pet"], "shopping"),
    **dict.fromkeys(["hospital", "pharmacy", "clinic", "medical center", "medical centre",
                     "dentist", "doctor"], "health"),
    **dict.fromkeys(["bank", "atm"], "finance"),
    **dict.fromkeys(["stadium", "park", "zoo", "cinema", "gym", "fitness", "spa"], "leisure"),
    **dict.fromkeys(["museum", "library", "theater", "theatre"], "culture"),
    **dict.fromkeys(["place of worship", "temple", "mosque", "church", "kovil", "cathedral",
                     "synagogue", "hindu temple", "buddhist temple"], "worship"),
    **dict.fromkeys(["airport", "bus station", "train station", "railway station",
                     "gas station", "fuel", "petrol"], "transport"),
    **dict.fromkeys(["government", "embassy", "military", "parliament", "ministry",
                     "police", "fire station", "courthouse", "court house", "post office",
                     "office"], "government"),
}
CELL_AT_7 = 1.5
CAP_BY_ZOOM = {7: 16, 8: 10, 9: 4, 10: 6, 11: 2, 12: 1, 13: 20}


def place_kind(categories: list[str]) -> tuple[str, str]:
    """Use the first existing GROUPS keyword match; do not invent categories."""
    for category in categories:
        low = category.lower()
        for _, _, keywords in GROUPS:
            for keyword in keywords:
                if keyword in low:
                    return KEYWORD_KIND.get(keyword, "other"), category.strip()[:32]
    return "other", ""


def display_label(name: str, record: dict) -> str:
    """Use an existing Latin-language label without changing the stored name.

    Do not translate or guess names. Mixed-script brands remain intact unless
    an explicit alias, delimiter-separated name, or full Latin phrase exists.
    """
    def latin(value):
        letters = [c for c in value if c.isalpha()]
        return bool(letters) and all(unicodedata.name(c, "").startswith("LATIN") for c in letters)

    aliases = [name, record.get("name_en", ""), *record.get("source", {}).get("names", [])]
    for alias in aliases:
        if isinstance(alias, str) and alias.strip() and latin(alias):
            return alias.strip()
    parts = re.split(r"[|/\n]", name)
    candidates = [part.strip() for part in parts
                  if latin(part) and sum(c.isalpha() for c in part) >= 3]
    if candidates:
        return max(candidates, key=lambda part: sum(c.isalpha() for c in part))
    phrases = re.findall(r"[A-Za-z][A-Za-z0-9 &'’.,()\-]*", name)
    phrases = [part.strip(" -/,()") for part in phrases
               if len(re.findall(r"[A-Za-z]+", part)) >= 2]
    return phrases[0] if len(phrases) == 1 else name


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


def select_by_zoom(features: list[dict], params: dict) -> dict[int, int]:
    """Assign persistent zoom bands using category order and per-cell budgets."""
    cell_at_7 = params.get("cell_at_7", CELL_AT_7)
    caps = params.get("cap_by_zoom", CAP_BY_ZOOM)
    place_ids = params.get("place_ids", {})
    if cell_at_7 <= 0 or any(caps[z] < 1 for z in range(7, 14)):
        raise ValueError("Cell size and zoom caps must be positive")
    ordered = sorted(features, key=lambda feature: (
        -rank_score(feature["properties"]["category"], feature["properties"]["name"]),
        str(place_ids.get(feature["id"], feature["id"])),
    ))
    assigned: dict[int, int] = {}
    for zoom in range(7, 14):
        cell_size = cell_at_7 / 2 ** (zoom - 7)
        occupancy: dict[tuple[int, int], int] = {}
        def cell(feature):
            lon, lat = feature["geometry"]["coordinates"]
            return math.floor(lon / cell_size), math.floor(lat / cell_size)
        # Earlier selections consume the current grid's capacity too. They are
        # never evicted, even when inherited occupancy exceeds the current cap.
        for feature in ordered:
            if feature["id"] in assigned:
                key = cell(feature)
                occupancy[key] = occupancy.get(key, 0) + 1
        # Give each occupied cell a mix of useful categories. The old single
        # score queue could fill every slot with offices before any food/shop
        # feature was considered. Keep the existing score/id order within each
        # category, and retain all earlier choices for monotonic membership.
        buckets = defaultdict(lambda: defaultdict(deque))
        kind_counts = defaultdict(lambda: defaultdict(int))
        kind_order = {kind: i for i, kind in enumerate((
            "food", "leisure", "culture", "shopping", "transport", "health",
            "finance", "worship", "government", "landmark", "other",
        ))}
        for feature in ordered:
            key = cell(feature)
            kind = feature["properties"].get("kind", "other")
            if feature["id"] in assigned:
                kind_counts[key][kind] += 1
            else:
                buckets[key][kind].append(feature)
        for key in sorted(buckets):
            available = buckets[key]
            while available and occupancy.get(key, 0) < caps[zoom]:
                kind = min(available, key=lambda k: (
                    kind_counts[key][k], kind_order.get(k, len(kind_order)), k,
                ))
                feature = available[kind].popleft()
                assigned[feature["id"]] = zoom
                occupancy[key] = occupancy.get(key, 0) + 1
                kind_counts[key][kind] += 1
                if not available[kind]:
                    del available[kind]
    for feature in ordered:
        assigned.setdefault(feature["id"], 14)
    return assigned


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
        kind, subtitle = place_kind(real_cats)
        label = display_label(name, rec)

        features.append({
            "type": "Feature",
            # Stable feature metadata allows exact deduplication across tile buffers.
            "id": int.from_bytes(hashlib.sha256(str(rid).encode()).digest()[:6], "big"),
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat],
            },
            "properties": {
                "name": name,
                **({"label": label} if label != name else {}),
                "category": primary,
                "min_zoom": mz,
                "priority": pri,
                "kind": kind,
                **({"subtitle": subtitle} if subtitle else {}),
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
    if len({feature["id"] for feature in features}) != len(features):
        raise ValueError("Place feature IDs are not unique")
    print("Kind counts:", {kind: sum(f["properties"]["kind"] == kind for f in features)
                           for kind in sorted({f["properties"]["kind"] for f in features})})

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

    # ── budgeted zoom bands → one places layer ────────────────────────
    place_ids = {features[index]["id"]: place_id for _, place_id, index in ranking}
    assigned_zooms = select_by_zoom(features, {"place_ids": place_ids})
    print("Selection constants:", CELL_AT_7, CAP_BY_ZOOM)
    print("Zoom bands:", {zoom: sum(z == zoom for z in assigned_zooms.values())
                          for zoom in range(7, 15)})
    tier_dir = BUILD_DIR / "tiers"
    tier_dir.mkdir(exist_ok=True)
    tier_archives = []
    for minimum_zoom in range(7, 15):
        tier_features = [feature for feature in features
                         if assigned_zooms[feature["id"]] == minimum_zoom]
        print(f"Band {minimum_zoom}: {len(tier_features)} features")
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
        tier_geojson = tier_dir / f"band_{minimum_zoom}.geojson"
        with tier_geojson.open("w") as output:
            json.dump({"type": "FeatureCollection", "features": tier_features}, output)
        tier_archive = tier_dir / f"band_{minimum_zoom}.pmtiles"
        cmd = [
            "tippecanoe",
            "-o", str(tier_archive),
            "-z", "14",
            "-Z", str(minimum_zoom),
            "-l", "places",
            "--no-feature-limit",
            "--no-tile-size-limit",
            "--drop-rate=1",
            "--force",
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
