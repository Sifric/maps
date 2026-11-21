"""Generate small, rebuildable Workers Assets shards from the Sifric search index."""

import gzip
import json
import math
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

source, output = map(Path, sys.argv[1:])
with gzip.open(source, 'rt', encoding='utf-8') as stream:
    rows = json.load(stream)

groups = defaultdict(list)
for row in rows:
    place_id, name, lon, lat, *_ = row
    label = row[6] or '' if len(row) > 6 else ''
    terms = unicodedata.normalize('NFKC', f'{name} {label}').lower().split()
    for key in {term[:2].encode('utf-8').hex() for term in terms if len(term) >= 2}:
        groups[f'search/{key}'].append(row)
    groups[f'id/{int(place_id) % 512}'].append(row)
    groups[f'near/{math.floor(lon * 10)}-{math.floor(lat * 10)}'].append(row)

for key, items in groups.items():
    file = output / (key + '.json')
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(items, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(f'Built {len(groups)} developer index shards from {len(rows)} places.')
