#!/usr/bin/env python3
"""Extract Sri Lanka cell locations from the pinned OpenCellID snapshot."""
import csv
import gzip
from pathlib import Path
import struct
import sys

RADIOS = {"GSM": 1, "UMTS": 2, "LTE": 3, "NR": 4}


def main(source, destination):
    with gzip.open(source, "rt", encoding="ascii", newline="") as data:
        locations = {}
        for row in csv.DictReader(data):
            if row["mcc"] != "413" or row["radio"] not in RADIOS:
                continue
            longitude = float(row["lon"])
            latitude = float(row["lat"])
            if not 78 <= longitude <= 82.5 or not 5 <= latitude <= 10.5:
                continue
            network, area, cell = (int(row[field]) for field in ("net", "area", "cell"))
            if not (0 <= network <= 999 and 0 <= area < 2**24 and 0 <= cell < 2**36):
                continue
            key = RADIOS[row["radio"]], network, area, cell
            samples = max(0, min(int(row["samples"]), 2**32 - 1))
            record = longitude, latitude, max(int(row["range"]), 0), samples
            if key not in locations or samples > locations[key][3]:
                locations[key] = record
    if not locations:
        raise ValueError("The OpenCellID extract has no Sri Lanka records")
    with Path(destination).open("wb") as output:
        output.write(struct.pack("<8sI", b"SIFRICC1", len(locations)))
        for key in sorted(locations):
            output.write(struct.pack("<HHIQffII", *key, *locations[key]))
    print(f"Indexed {len(locations)} mobile cells")


if __name__ == "__main__":
    main(*sys.argv[1:])
