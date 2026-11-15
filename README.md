# lkmaps

Sri Lanka places data, copied from MazoPlatforms/newmaps (data/places).

## Place storage

Records live in `data/places/0001/<id>.json`, `0002/<id>.json`, and so on.
Each numbered folder contains at most **999 records**. `aliases.json` stays at
`data/places/` and is not a place record. Filenames and record IDs are stable;
the folder is only a storage location.

The OSM importer fills the last numbered folder before opening the next one.
Run `python3 scripts/numbered_shards.py` to validate this layout. The build also
checks the layout and every file against `places.sha256`.
