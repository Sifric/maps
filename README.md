# Sifric Maps

An interactive map of Sri Lanka with searchable places, progressive place markers, map display controls, and route planning. Sifric Maps combines an OpenStreetMap basemap with a separately maintained places dataset and serves the application through a Cloudflare Worker.

Repository: [Sifric/maps](https://github.com/Sifric/maps).

> Sifric Maps is a Sri Lanka-focused mapping application and supporting map-data pipeline. Map coverage, routing quality, and optional layers vary with the available data and services. This repository is not a guaranteed-availability navigation service.

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

## Getting started

For a quick overview, start with `worker/public/` for the browser application, `worker/index.js` for its backend endpoints, and `config/style/mazo-basemap.json` for the rendered map style. The development commands below run a local Worker, but a functioning basemap also requires the configured PMTiles data in R2 or a local fixture.

For contributors working only on place data, see **Place storage** and **Building map assets** before editing numbered shards. For production changes, review **Deployment** and the actual workflow before running it.

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

## Data flow

1. Place records are maintained in numbered JSON shards under `data/places/`.
2. The build scripts validate and transform the source data into search and map assets.
3. The map build produces PMTiles archives; the deployment workflow verifies a published release archive before uploading it to R2.
4. The Cloudflare Worker serves the browser application and map resources. The browser renders vector data with MapLibre GL JS.
5. Routing requests go through the application's endpoint to a public OSRM service, so route availability is not controlled entirely by this repository.

The place dataset and the basemap are separate inputs. Updating a place JSON file does not, by itself, guarantee that a deployed tile archive or search index changes; the relevant build and deployment steps must run.

## Place storage

Records live in `data/places/0001/<id>.json`, `0002/<id>.json`, and subsequent numbered folders. Each folder contains at most **999 records**. Record IDs and ULID filenames remain stable; folders organize storage rather than identify places. `aliases.json` is metadata and is not a place record.

The OSM importer fills the last numbered folder before opening another. Validate the layout with:

```bash
python3 scripts/numbered_shards.py
```

Build validation also checks records against `places.sha256`. Update data and its checksum manifest together through the intended import workflow. Do not treat the GitHub directory listing limit as evidence of missing records.

## Repository guide

| Path | What to inspect |
| --- | --- |
| `worker/public/` | Browser UI and client-side map interactions |
| `worker/index.js` | Worker request handling and map endpoints |
| `worker/wrangler.jsonc` | Cloudflare Worker, static assets, and R2 binding |
| `config/style/mazo-basemap.json` | MapLibre style JSON used by the deployment |
| `data/places/` | Numbered source place records |
| `scripts/` | Validation and map/search asset generation |
| `.github/workflows/` | CI, builds, and deployment definitions |

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

## Common checks

Before submitting a change, run the checks relevant to the files you edited:

```bash
# Validate numbered place-shard layout
python3 scripts/numbered_shards.py

# Validate the map style JSON
python3 -m json.tool config/style/mazo-basemap.json > /dev/null

# Check Worker deployment packaging without publishing
(cd worker && npx wrangler deploy --dry-run)
```

These checks do not replace the repository's full build pipeline, nor do they prove that a public routing service or deployed tiles are available. Follow the GitHub Actions workflows for any additional validation required by the change.

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

## Deployment configuration notes

The checked-in `worker/wrangler.jsonc` currently names the Worker `maps` and binds the R2 bucket `mazo-maps` as `TILES_BUCKET`. These infrastructure identifiers are not automatically renamed when public branding or URLs change. The deploy workflow currently uploads `lkmaps/sri-lanka.pmtiles` into that bucket and copies the map style to `worker/style.json` before publishing the Worker.

If migrating a `workers.dev` hostname, first confirm that the destination Cloudflare account and Workers subdomain are configured. Updating URLs in style JSON or documentation alone does not provision a Worker, migrate R2 objects, or alter the Cloudflare account's subdomain.

## Routing and availability

Routing uses a shared public OSRM REST service, which has no application-specific uptime guarantee. The Worker spaces requests within each isolate; this is not an account-wide traffic limit. Public service availability, supported profiles, and underlying road data determine route quality. This deployment does not require a paid Cloudflare Container fallback.

## Contributing

Contributions should be scoped to the relevant part of the system: UI, style, source places, build tooling, or deployment. For place edits, preserve stable record IDs and shard layout; for style edits, keep the JSON valid and verify referenced assets. Avoid committing generated archives or credentials unless the established repository workflow explicitly calls for an artifact.

When reporting a bug, include the affected page or endpoint, reproduction steps, expected versus actual behavior, and whether the issue occurs locally or on a deployed Worker. Do not include API tokens or personal location information in public issues.

## Troubleshooting

- **Map interface loads but tiles do not:** verify the Worker R2 binding, PMTiles object availability, and tile requests. A local Worker does not automatically fetch the basemap.
- **Place changes are not visible:** check whether search-index and place-tile generation were run and whether the updated assets were deployed.
- **Routes fail or differ by mode:** inspect the route endpoint and public OSRM availability; the configured service does not guarantee distinct profiles for every travel mode.
- **Worker deployment fails:** verify the selected GitHub environment, required Cloudflare secrets, Wrangler configuration, and workflow logs.
- **A renamed Workers URL does not respond:** check Cloudflare account/subdomain ownership and the actual deployed Worker route; a JSON URL replacement is not a deployment.

## Attribution and assets

Basemap attribution: **© OpenStreetMap contributors**. Preserve the map's attribution when embedding or redistributing it, and review applicable data licenses before redistribution.

Font assets include their supplied license files under `worker/public/assets/fonts/`. Preserve those notices and the existing glyph stack identifiers when changing branding. Third-party libraries, imagery sources, and assets retain their respective licenses and attribution requirements.

Sifric Maps is an independent project and is not affiliated with Google Maps.
