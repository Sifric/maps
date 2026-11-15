#!/usr/bin/env python3
"""Replace only the places layer, retaining every other encoded MVT layer.

Requires pmtiles==3.8.1. No geometry decode/re-encode, basemap rebuild, or
tile-join is used here. A full output verification checks every retained layer.
"""
import argparse
import copy
import gzip
import hashlib
import json
from pathlib import Path

from pmtiles.reader import Reader, MmapSource, all_tiles
from pmtiles.writer import Writer
from pmtiles.tile import Compression, zxy_to_tileid


def varint(data, offset):
    value = shift = 0
    while offset < len(data) and shift < 70:
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, offset
        shift += 7
    raise ValueError("Invalid protobuf varint")


def fields(data):
    offset = 0
    while offset < len(data):
        start = offset
        key, offset = varint(data, offset)
        wire = key & 7
        if wire == 2:
            length, offset = varint(data, offset)
            value = data[offset:offset + length]
            offset += length
        elif wire == 0:
            value, offset = varint(data, offset)
        elif wire in (1, 5):
            length = 8 if wire == 1 else 4
            value = data[offset:offset + length]
            offset += length
        else:
            raise ValueError(f"Unsupported protobuf wire type {wire}")
        if offset > len(data):
            raise ValueError("Truncated protobuf field")
        yield key >> 3, value, data[start:offset]


def layers(data):
    """Yield (layer name, complete original Tile field bytes)."""
    for number, payload, raw in fields(data):
        if number != 3:
            raise ValueError("Unexpected vector tile field")
        name = next(value.decode() for key, value, _ in fields(payload) if key == 1)
        yield name, raw


def unpack(data, compression):
    if compression == Compression.GZIP:
        return gzip.decompress(data)
    if compression == Compression.NONE:
        return data
    raise ValueError("Only gzip and uncompressed tiles are supported")


def retained(data, compression):
    return b"".join(raw for name, raw in layers(unpack(data, compression)) if name != "places")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("places", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.resolve() in (args.baseline.resolve(), args.places.resolve()):
        raise ValueError("Output must not overwrite either input")
    if args.output.exists():
        raise ValueError("Output exists; choose a fresh output path")
    with args.baseline.open("rb") as base_file, args.places.open("rb") as places_file:
        base_source, place_source = MmapSource(base_file), MmapSource(places_file)
        base_reader, place_reader = Reader(base_source), Reader(place_source)
        header = base_reader.header()
        compression = header["tile_compression"]
        place_compression = place_reader.header()["tile_compression"]
        base_tiles = {zxy: data for zxy, data in all_tiles(base_source)}
        place_tiles = {}
        for zxy, data in all_tiles(place_source):
            items = list(layers(unpack(data, place_compression)))
            if any(name != "places" for name, _ in items):
                raise ValueError("Replacement archive must contain only places")
            place_tiles[zxy] = b"".join(raw for _, raw in items)
        metadata = copy.deepcopy(base_reader.metadata())
        replacement = place_reader.metadata()
        metadata["vector_layers"] = [layer for layer in metadata["vector_layers"]
                                     if layer["id"] != "places"] + replacement["vector_layers"]
        if "tilestats" in metadata and "tilestats" in replacement:
            stats = metadata["tilestats"]
            stats["layers"] = [layer for layer in stats["layers"] if layer["layer"] != "places"] + replacement["tilestats"]["layers"]
            stats["layerCount"] = len(stats["layers"])
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("xb") as output:
            writer = Writer(output)
            for zxy in sorted(base_tiles.keys() | place_tiles.keys(), key=lambda p: zxy_to_tileid(*p)):
                original = base_tiles.get(zxy)
                remaining = retained(original, compression) if original else b""
                merged = remaining + place_tiles.get(zxy, b"")
                if not merged:
                    continue
                if original and merged == unpack(original, compression):
                    data = original
                else:
                    data = gzip.compress(merged, mtime=0) if compression == Compression.GZIP else merged
                writer.write_tile(zxy_to_tileid(*zxy), data)
            writer.finalize(header.copy(), metadata)
        # Verify the produced file, not just the inputs to the writer.
        with args.output.open("rb") as output:
            source = MmapSource(output)
            seen = set()
            checked = 0
            for zxy, data in all_tiles(source):
                seen.add(zxy)
                before = base_tiles.get(zxy)
                expected = retained(before, compression) if before else b""
                if retained(data, compression) != expected:
                    raise ValueError(f"Non-places layer changed at {zxy}")
                actual_places = b"".join(raw for name, raw in layers(unpack(data, compression)) if name == "places")
                if actual_places != place_tiles.get(zxy, b""):
                    raise ValueError(f"Places layer mismatch at {zxy}")
                checked += 1
            for zxy in base_tiles.keys() - seen:
                if retained(base_tiles[zxy], compression):
                    raise ValueError(f"Basemap tile lost at {zxy}")
        print(f"PASS: {checked} output tiles verified; every non-places layer byte unchanged")
    manifest_path = args.output.parent / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    digest = hashlib.file_digest(args.output.open("rb"), "sha256").hexdigest()
    manifest.update(file=args.output.name, sha256=digest, sha8=digest[:8],
                    attribution=metadata.get("attribution"),
                    baseline_sha256=hashlib.file_digest(args.baseline.open("rb"), "sha256").hexdigest(),
                    non_places_layers_unchanged=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
