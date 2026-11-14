#!/usr/bin/env python3
"""Derive Sri Lanka land by subtracting cached OSM water from its bbox."""

import json
import sys
import time
from pathlib import Path

import pyogrio
from pyogrio.raw import read
from pyproj import CRS, Transformer
from shapely import from_wkb, transform
from shapely.geometry import box, mapping
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / ".cache/sources/water-polygons-split-3857.zip"
OUTPUT = ROOT / "build/country_land.geojson"
BOUNDS = (78.0, 5.0, 82.5, 10.5)
SRI_LANKA_BOUNDS = (79.5, 5.9, 82.0, 9.9)


def polygons(geometry):
    if geometry.geom_type == "Polygon":
        yield geometry
    elif geometry.geom_type in ("MultiPolygon", "GeometryCollection"):
        for part in geometry.geoms:
            yield from polygons(part)


def main():
    started = time.perf_counter()
    if not INPUT.is_file():
        raise ValueError(f"Missing cached water archive: {INPUT}")
    forward = Transformer.from_crs(4326, 3857, always_xy=True)
    backward = Transformer.from_crs(3857, 4326, always_xy=True)
    bounds = forward.transform_bounds(*BOUNDS)
    source = f"/vsizip/{INPUT}/water-polygons-split-3857/water_polygons.shp"
    info = pyogrio.read_info(source)
    if not CRS.from_user_input(info["crs"]).equals(CRS.from_epsg(3857)):
        raise ValueError(f"Expected EPSG:3857 water polygons, got {info['crs']}")
    # Read WKB directly without requiring geopandas.
    _, _, geometries, _ = read(source, bbox=bounds, columns=[])
    if geometries is None or len(geometries) == 0:
        raise ValueError("No water polygons intersect the full bbox")
    water = from_wkb(geometries)
    if any(g is None or g.is_empty or not g.is_valid for g in water):
        raise ValueError("Water polygons contain missing, empty, or invalid geometry")
    print(f"Water polygons read: {len(water)}", flush=True)
    land = box(*bounds).difference(unary_union(water))
    def to_lonlat(coordinates):
        lon, lat = backward.transform(coordinates[:, 0], coordinates[:, 1])
        return list(zip(lon, lat))

    land = transform(land, to_lonlat)
    all_parts = list(polygons(land))
    west, south, east, north = BOUNDS
    tolerance = 1e-6
    retained = []
    for part in all_parts:
        min_lon, min_lat, max_lon, max_lat = part.bounds
        touches_edge = (
            abs(min_lon - west) <= tolerance
            or abs(max_lon - east) <= tolerance
            or abs(min_lat - south) <= tolerance
            or abs(max_lat - north) <= tolerance
        )
        if not touches_edge:
            retained.append(part)
    print(f"BBox-edge filter: polygons before={len(all_parts)}; "
          f"after={len(retained)}; removed={len(all_parts) - len(retained)}", flush=True)
    parts = [part for part in retained if part.area >= 1e-9]
    land = unary_union(parts)
    sri_lanka_box = box(*SRI_LANKA_BOUNDS)
    area = land.intersection(sri_lanka_box).area
    print(f"Sri Lanka-box area after edge filtering: {area:.8f} degrees²", flush=True)
    print(f"Full-bbox land area: {land.area:.8f} degrees²; "
          f"Sri Lanka-box land area: {area:.8f} degrees²; "
          f"polygon count: {len(parts)}", flush=True)
    if land.is_empty or not land.is_valid or not 4.8 <= area <= 6.6:
        raise ValueError(f"Invalid land geometry or Sri Lanka-box area {area:.8f}; expected 4.8–6.6 degrees²")
    land = land.simplify(0.00008, preserve_topology=True)
    simplified_area = land.intersection(sri_lanka_box).area
    if land.is_empty or not land.is_valid or not 4.8 <= simplified_area <= 6.6:
        raise ValueError("Simplified land geometry is invalid or Sri Lanka-box area is outside 4.8–6.6 degrees²")
    collection = {"type": "FeatureCollection", "features": [{
        "type": "Feature", "properties": {"name": "Sri Lanka"},
        "geometry": mapping(land),
    }]}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(collection) + "\n")
    print(f"Wrote {OUTPUT}: 1 feature; {len(list(polygons(land)))} polygons; "
          f"simplified full-bbox area: {land.area:.8f} degrees²; "
          f"simplified Sri Lanka-box area: {simplified_area:.8f} degrees²")
    print(f"Runtime: {time.perf_counter() - started:.2f} seconds")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
