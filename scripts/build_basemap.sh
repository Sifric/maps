#!/usr/bin/env bash
set -euo pipefail

# Build an OpenMapTiles-compatible basemap PMTiles from the Geofabrik Sri Lanka extract.
# Downloads to .cache/ (gitignored), verifies md5, runs Planetiler v0.10.2.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_DIR="${REPO_ROOT}/.cache"
BUILD_DIR="${REPO_ROOT}/build"
PBF_URL="https://download.geofabrik.de/asia/sri-lanka-latest.osm.pbf"
MD5_URL="${PBF_URL}.md5"
PBF_FILE="${CACHE_DIR}/sri-lanka-latest.osm.pbf"
MD5_FILE="${CACHE_DIR}/sri-lanka-latest.osm.pbf.md5"
PLANETILER_VERSION="0.10.2"
PLANETILER_JAR="${CACHE_DIR}/planetiler-${PLANETILER_VERSION}.jar"
PLANETILER_URL="https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar"
OUTPUT="${BUILD_DIR}/basemap.pmtiles"

mkdir -p "${CACHE_DIR}" "${BUILD_DIR}"

# --- Download and verify PBF ---
echo "==> Downloading MD5 checksum..."
curl -fsSL -o "${MD5_FILE}" "${MD5_URL}"
EXPECTED_MD5=$(awk '{print $1}' "${MD5_FILE}")
echo "    Expected MD5: ${EXPECTED_MD5}"

if [ -f "${PBF_FILE}" ]; then
    ACTUAL_MD5=$(md5sum "${PBF_FILE}" | awk '{print $1}')
    if [ "${ACTUAL_MD5}" = "${EXPECTED_MD5}" ]; then
        echo "==> Cached PBF is valid (MD5 matches), skipping download."
    else
        echo "==> Cached PBF is stale (MD5 mismatch), re-downloading..."
        rm -f "${PBF_FILE}"
    fi
fi

if [ ! -f "${PBF_FILE}" ]; then
    echo "==> Downloading Sri Lanka PBF..."
    curl -fSL -o "${PBF_FILE}" "${PBF_URL}"
    ACTUAL_MD5=$(md5sum "${PBF_FILE}" | awk '{print $1}')
    if [ "${ACTUAL_MD5}" != "${EXPECTED_MD5}" ]; then
        echo "::error::MD5 mismatch! Expected ${EXPECTED_MD5}, got ${ACTUAL_MD5}"
        exit 1
    fi
    echo "    MD5 verified: ${ACTUAL_MD5}"
fi

# --- Download Planetiler JAR ---
if [ ! -f "${PLANETILER_JAR}" ]; then
    echo "==> Downloading Planetiler v${PLANETILER_VERSION}..."
    curl -fSL -o "${PLANETILER_JAR}" "${PLANETILER_URL}"
fi
echo "    Planetiler JAR: $(du -h "${PLANETILER_JAR}" | cut -f1)"

# --- Run Planetiler ---
echo "==> Running Planetiler (OpenMapTiles profile, zoom 0-14, Sri Lanka)..."
java -Xmx3g -jar "${PLANETILER_JAR}" \
    --download \
    --osm-path="${PBF_FILE}" \
    --output="${OUTPUT}" \
    --output-format=pmtiles \
    --maxzoom=14 \
    --minzoom=0 \
    --bounds=78.0,5.0,82.5,10.5 \
    --simplify_tolerance=0.05 \
    --simplify_tolerance_at_max_zoom=0.03125 \
    --force \
    --nodemap-type=sortedtable \
    --nodemap-storage=mmap \
    --storage=mmap \
    --download-threads=2 \
    --threads="$(nproc)" \
    --download-dir="${CACHE_DIR}/sources" \
    --tmpdir="${CACHE_DIR}/tmp"

echo "✓ Basemap built: ${OUTPUT} ($(du -h "${OUTPUT}" | cut -f1))"
