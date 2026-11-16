# Sifric Maps

An interactive map of Sri Lanka with searchable places, progressive place markers, map display controls, and route planning. Sifric Maps combines an OpenStreetMap basemap with a separately maintained places dataset and serves the application through a Cloudflare Worker.

Repository: [Sifric/maps](https://github.com/Sifric/maps).

## Features

- Search places by name and inspect their details on the map.
- Display places progressively as the map zoom changes.
- Save places and revisit recent searches using browser storage.
- Choose light, dark, or system appearance.
- Switch between default, satellite, and terrain views where the configured sources support them.
- Toggle mapped transit, cycling, and building details where available.
- Plan routes between searched places or coordinates using the public OSRM REST API.
- Use browser geolocation with the user's permission.

Map details depend on source coverage. Transit displays mapped infrastructure rather than live arrivals, and a live traffic feed is not currently connected. Drive and two-wheeler routing share a driving profile; two-wheeler results are an approximation. A successful response from a public routing endpoint does not guarantee a distinct walking profile.

## Architecture

The browser uses MapLibre GL JS and the PMTiles protocol to render the map. A Cloudflare Worker serves the application, style, sprites, font glyphs, and byte ranges from the PMTiles archive stored in R2. Route requests pass through the application's route endpoint to the public OSRM service.

| Component | Location | Purpose |
| --- | --- | --- |
| Application | `worker/public/` | Map interface, search, themes, and directions |
| Worker | `worker/index.js` | Style, assets, tiles, and routing endpoints |
| Worker configuration | `worker/wrangler.jsonc` | Worker assets and R2 binding |
| Map style | `config/style/mazo-basemap.json` | Basemap and place styling |
| Places | `data/places/` | Place records in numbered shards |
| Build scripts | `scripts/` | Data validation, search index, and tile generation |
| Workflows | `.github/workflows/` | Tile builds and manual deployment |

Some internal filenames, font stacks, storage keys, and infrastructure names retain historical identifiers for compatibility. The public application brand is Sifric Maps.

## Place storage

Records live in `data/places/0001/<id>.json`, `0002/<id>.json`, and subsequent numbered folders. Each folder contains at most **999 records**. Record IDs and ULID filenames remain stable; folders organize storage rather than identify places. `aliases.json` is metadata and is not a place record.

The OSM importer fills the last numbered folder before opening another. Validate the layout with:

```bash
python3 scripts/numbered_shards.py
```

Build validation also checks records against `places.sha256`. Update data and its checksum manifest together through the intended import workflow. Do not treat the GitHub directory listing limit as evidence of missing records.

## Local development

Clone the repository and prepare the generated worker style:

```bash
git clone https://github.com/Sifric/maps.git
cd maps
cp config/style/mazo-basemap.json worker/style.json
cd worker
npx wrangler dev
```

Tile requests require an available PMTiles object through the configured R2 binding or a suitable local R2 fixture. Starting the application alone does not download the basemap. Browser location access requires permission and a secure context such as HTTPS or localhost.

Check the worker bundle without deploying:

```bash
cd worker
npx wrangler deploy --dry-run
```

Keep credentials in environment variables or platform secrets. Never commit tokens, local Wrangler state, generated tile archives, or development secret files.

## Building map assets

The build uses Python, Planetiler, tippecanoe, tile-join, and the PMTiles CLI. Individual scripts may require additional Python geospatial packages; consult the build workflow for the installed toolchain.

- `build_places_tiles.py` validates places and builds zoom bands into `build/places.pmtiles`.
- `build_search_index.py` generates the browser search index.
- `build_basemap.sh` builds the Sri Lanka OpenStreetMap basemap with Planetiler.
- `build_country_land.py` derives land geometry from cached water polygons.
- `merge_tiles.sh` combines the basemap, land, and places archives.

Outputs go under `build/`; downloads and reusable sources go under `.cache/`. Full basemap generation requires substantially more resources than frontend development. Prefer the configured GitHub Actions build for a complete archive.

## Deployment

The **Deploy Maps** workflow is manually triggered with a `release_tag`. It downloads the release archive, verifies zooms 0–14 and the `country_land` layer, uploads the archive through the configured R2 step, prepares the bundled style, and deploys the Worker.

```bash
gh workflow run deploy-maps.yml --repo Sifric/maps --ref main \
  -f release_tag=<published-release-tag>
```

The `production` environment must provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Review the workflow and Wrangler configuration before deploying to an existing environment. Deployment permissions and environment approval rules are configured in GitHub.

## Routing and availability

Routing uses a shared public OSRM REST service, which has no application-specific uptime guarantee. The Worker spaces requests within each isolate; this is not an account-wide traffic limit. Public service availability, supported profiles, and underlying road data determine route quality. This deployment does not require a paid Cloudflare Container fallback.

## Attribution and assets

Basemap attribution: **© OpenStreetMap contributors**. Preserve the map's attribution when embedding or redistributing it, and review applicable data licenses before redistribution.

Font assets include their supplied license files under `worker/public/assets/fonts/`. Preserve those notices and the existing glyph stack identifiers when changing branding. Third-party libraries, imagery sources, and assets retain their respective licenses and attribution requirements.

Sifric Maps is an independent project and is not affiliated with Google Maps.
