#!/bin/sh
set -eu

PBF_URL="https://download.geofabrik.de/asia/sri-lanka-latest.osm.pbf"
PBF_PATH="/data/sri-lanka-latest.osm.pbf"
MD5_PATH="/tmp/sri-lanka-latest.osm.pbf.md5"

mkdir -p /data
download() {
  download_url="$1"
  download_destination="$2"
  download_attempt=1
  while [ "${download_attempt}" -le 3 ]; do
    if wget -q -O "${download_destination}" "${download_url}"; then
      return 0
    fi
    sleep "${download_attempt}"
    download_attempt=$((download_attempt + 1))
  done
  echo "Could not download ${download_url}" >&2
  return 1
}

download "${PBF_URL}.md5" "${MD5_PATH}"
expected_md5="$(awk '{print $1}' "${MD5_PATH}")"
if [ -z "${expected_md5}" ]; then
  echo "Geofabrik did not provide an MD5 checksum" >&2
  exit 1
fi

if [ ! -f "${PBF_PATH}" ]; then
  download "${PBF_URL}" "${PBF_PATH}.download"
  actual_md5="$(md5sum "${PBF_PATH}.download" | awk '{print $1}')"
  if [ "${actual_md5}" != "${expected_md5}" ]; then
    echo "Downloaded Sri Lanka OSM PBF did not match the published checksum" >&2
    exit 1
  fi
  mv "${PBF_PATH}.download" "${PBF_PATH}"
fi

actual_md5="$(md5sum "${PBF_PATH}" | awk '{print $1}')"
if [ "${actual_md5}" != "${expected_md5}" ]; then
  echo "Sri Lanka OSM PBF MD5 verification failed" >&2
  exit 1
fi

prepare_profile() {
  profile_name="$1"
  profile_path="$2"
  profile_directory="/data/${profile_name}"
  profile_base="${profile_directory}/sri-lanka"

  mkdir -p "${profile_directory}"
  ln -sf "${PBF_PATH}" "${profile_base}.osm.pbf"
  if [ ! -f "${profile_base}.osrm.cells" ] || [ ! -f "${profile_base}.osrm.cell_metrics" ]; then
    osrm-extract -p "${profile_path}" "${profile_base}.osm.pbf"
    osrm-partition "${profile_base}.osrm"
    osrm-customize "${profile_base}.osrm"
  fi
}

# The fallback is started only when the public OSRM service is unavailable or throttled.
prepare_profile car /opt/car.lua
prepare_profile foot /opt/foot.lua

osrm-routed --algorithm mld --port 5000 /data/car/sri-lanka.osrm &
car_pid=$!
osrm-routed --algorithm mld --port 5001 /data/foot/sri-lanka.osrm &
foot_pid=$!

cleanup() {
  kill "${car_pid}" "${foot_pid}" 2>/dev/null || :
}
trap cleanup 0 INT TERM

while kill -0 "${car_pid}" 2>/dev/null && kill -0 "${foot_pid}" 2>/dev/null; do
  sleep 1
done
exit 1
