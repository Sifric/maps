#!/usr/bin/env bash
set -euo pipefail

# Merge basemap and places PMTiles into a single sri-lanka.pmtiles file.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${REPO_ROOT}/build"
BASEMAP="${BUILD_DIR}/basemap.pmtiles"
PLACES="${BUILD_DIR}/places.pmtiles"
COUNTRY_LAND="${BUILD_DIR}/country_land.pmtiles"
OUTPUT="${BUILD_DIR}/sri-lanka.pmtiles"

for f in "${BASEMAP}" "${PLACES}" "${COUNTRY_LAND}"; do
    if [ ! -f "$f" ]; then
        echo "::error::Missing input: $f"
        exit 1
    fi
done

echo "==> Merging basemap + places into sri-lanka.pmtiles..."
tile-join \
    -o "${OUTPUT}" \
    --force \
    --no-tile-size-limit \
    --attribution='© OpenStreetMap contributors' \
    --name='Sri Lanka Map' \
    "${BASEMAP}" \
    "${PLACES}" \
    "${COUNTRY_LAND}"

# Publish a manifest identifying the merged archive, retaining places statistics.
python3 - "${BUILD_DIR}" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

build = Path(sys.argv[1])
archive = build / "sri-lanka.pmtiles"
digest = hashlib.sha256()
with archive.open("rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
manifest_path = build / "manifest.json"
manifest = json.loads(manifest_path.read_text())
manifest.update(file=archive.name, sha256=digest.hexdigest(),
                sha8=digest.hexdigest()[:8], attribution="© OpenStreetMap contributors")
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
PY

echo "✓ Merged tileset: ${OUTPUT} ($(du -h "${OUTPUT}" | cut -f1))"
