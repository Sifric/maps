#!/usr/bin/env python3
"""Pack the Sri Lanka subset of NOAA/NCEI ETOPO 2022 as little-endian meter values."""
import struct
import sys

import numpy as np
from scipy.io import netcdf_file


def main(source, destination):
    with netcdf_file(source, mmap=False) as dataset:
        lat = dataset.variables["latitude"][:]
        lon = dataset.variables["longitude"][:]
        values = dataset.variables["z"][:]
    step = 1 / 240
    if (
        values.shape != (len(lat), len(lon))
        or not np.allclose(np.diff(lat), step, rtol=0, atol=1e-10)
        or not np.allclose(np.diff(lon), step, rtol=0, atol=1e-10)
        or not (lat[0] <= 5 < 10.5 <= lat[-1] and lon[0] <= 78 < 82.5 <= lon[-1])
        or not np.isfinite(values).all()
        or values.min() < -12000
        or values.max() > 9000
    ):
        raise ValueError("Unexpected ETOPO 2022 crop or sample values")
    with open(destination, "wb") as output:
        output.write(struct.pack("<8sddII", b"SIFRICE1", lon[0], lat[0], len(lon), len(lat)))
        output.write(np.rint(values).astype("<i2").tobytes())


if __name__ == "__main__":
    main(*sys.argv[1:])
