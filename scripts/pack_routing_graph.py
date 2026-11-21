#!/usr/bin/env python3
"""Pack routing index columns without changing route weights or geometry."""
from array import array
from pathlib import Path
import shutil
import struct
import sys

MISSING = 2**32 - 1
COLUMNS = 23
FLOAT_COLUMNS = {5, 6}


def exact(file, length):
    data = file.read(length)
    if len(data) != length:
        raise ValueError("Incomplete routing index")
    return data


def main(source, destination):
    with Path(source).open("rb") as data, Path(destination).open("wb") as packed:
        magic, core_length = struct.unpack("<8sI", exact(data, 12))
        if magic != b"SIFRIC02" or not 12 < core_length <= 80 * 2**20:
            raise ValueError("Unsupported routing index")
        packed.write(struct.pack("<8sI", b"SIFRIC03", 0))
        for column in range(COLUMNS):
            count = struct.unpack("<I", exact(data, 4))[0]
            if data.tell() + count * 4 > core_length:
                raise ValueError("Column exceeds routing index")
            raw = exact(data, count * 4)
            width = 4
            if column not in FLOAT_COLUMNS:
                values = array("I", raw)
                if sys.byteorder != "little":
                    values.byteswap()
                maximum = max((value for value in values if value != MISSING), default=0)
                width = next(value for value in range(1, 5) if maximum < 256**value - 1)
            packed.write(struct.pack("<II", count, width))
            if width == 4:
                packed.write(raw)
            elif width == 1:
                packed.write(raw[0::4])
            else:
                compact = bytearray(count * width)
                for byte in range(width):
                    compact[byte::width] = raw[byte::4]
                packed.write(compact)
            packed.write(b"\0" * (-(count * width) % 4))
        if data.tell() != core_length:
            raise ValueError("Unexpected end of routing columns")
        packed_core = packed.tell()
        if packed_core > 62 * 2**20:
            raise ValueError("Packed routing index exceeds the Worker memory budget")
        shutil.copyfileobj(data, packed)
        packed.seek(8)
        packed.write(struct.pack("<I", packed_core))
    print(f"Packed routing core from {core_length / 2**20:.2f} MiB to {packed_core / 2**20:.2f} MiB")


if __name__ == "__main__":
    main(*sys.argv[1:])
