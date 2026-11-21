#!/usr/bin/env python3
"""Index exactly mapped Sri Lanka house numbers and streets from OSM."""
from collections import defaultdict
from hashlib import sha256
from pathlib import Path
import json
import re
import sys
import unicodedata
import osmium


def normalize(value):
    return " ".join(unicodedata.normalize("NFKC", value).lower().strip().split())


class Premises(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.index = defaultdict(set)

    def inspect(self, tags):
        number = tags.get("addr:housenumber", "").strip()
        street = tags.get("addr:street", "").strip()
        locality = tags.get("addr:city", tags.get("addr:town", tags.get("addr:village", ""))).strip()
        postcode = tags.get("addr:postcode", "").strip()
        if not number or not street or not (locality or postcode) or len(number) > 30 or len(street) > 120:
            return
        postcode = postcode if re.fullmatch(r"[0-9]{5}", postcode) else ""
        if not (locality or postcode):
            return
        building = tags.get("building", "")
        if building in {"apartments", "residential", "house", "detached", "semidetached_house", "terrace", "bungalow"}:
            category = "residential"
        elif building in {"commercial", "office", "retail", "warehouse", "industrial", "supermarket"}:
            category = "commercial"
        else:
            category = "unknown"
        key = sha256((normalize(number) + "\n" + normalize(street)).encode()).hexdigest()[:24]
        self.index[key].add((normalize(locality), postcode, category))

    def node(self, node):
        self.inspect(node.tags)

    def way(self, way):
        self.inspect(way.tags)

    def relation(self, relation):
        self.inspect(relation.tags)


if __name__ == "__main__":
    handler = Premises()
    handler.apply_file(sys.argv[1])
    if not handler.index:
        raise ValueError("No mapped premises found")
    payload = {key: sorted(records) for key, records in sorted(handler.index.items())}
    Path(sys.argv[2]).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Indexed {len(payload)} distinct house-number and street pairs")
