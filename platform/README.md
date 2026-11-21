# Sifric Maps Platform

The Sifric Worker continues to serve its public map. The developer portal is
`https://maps.sifric.workers.dev/developer/`, and the developer API prefix is
`https://maps.sifric.workers.dev/developer/api/v1`. Developer access requires a
Sifric credential and has no dependency on GitHub accounts or repository access.

The Node.js 24 service uses the existing Sifric place index and configured mapping
services. It binds to localhost by default, and will only start with a valid private
backend credential. The SDK, embed and portal are bundled outside the Worker public
assets directory and delivered through the authenticated gateway.

```sh
npm ci --prefix platform
npm test --prefix platform
SIFRIC_PLATFORM_TOKEN=YOUR_PRIVATE_BACKEND_TOKEN npm start --prefix platform
```

All developer-facing API paths below use the prefix `/developer/api/v1`. Requests and GeoJSON positions use **longitude, latitude** order. The service returns `503` for features with missing configuration. Sri Lanka bounds are a bounding-box check. They do not provide coastline or jurisdiction validation.

| Method and path | Inputs and behavior |
| --- | --- |
| GET `/health`, `/capabilities` | Service status and configured features |
| GET `/places/search` | `q`, optional `limit`. Searches index names and alternate labels. Use for autocomplete. |
| GET `/places/nearby` | `lon`, `lat`, optional `radius` in meters and `limit` |
| GET `/places/:id` | Record from the Sifric place index |
| GET `/geocode`, `/geocode/reverse` | Search text `q` or `lon` and `lat`. Uses Nominatim if configured. The default returns indexed place matches and explicitly identifies their precision. |
| GET `/timezone` | `lon`, `lat`, optional ISO timestamp with offset. Returns the IANA Asia/Colombo offset for the timestamp. |
| GET `/elevation` | `lon`, `lat`. Returns the nearest sample in a configured SRTM HGT tile. |
| GET `/tiles/:z/:x/:y.pbf` | MVT from the configured local PMTiles archive |
| GET `/static-map` | `lon`, `lat`, optional `zoom`, `width`, `height`, `pin=1`. Returns PNG including map attribution. |
| POST `/routes`, `/matrix` | JSON `coordinates: [[lon, lat], ...]` and `mode`. Matrix also accepts zero-based `sources` and `destinations`. |
| POST `/roads/nearest`, `/roads/match` | The same coordinates and mode contract. Nearest takes one point, and match takes 2–25 points. |
| POST `/optimize` | VROOM JSON with `vehicles` plus `jobs`, `shipments`, or both. The optimizer consumes optional vehicle capacities and time windows. |

## Cloudflare Workers API

The authenticated Worker serves `/health`, `/capabilities`, `/places/search`,
`/places/nearby`, `/places/:id`, `/timezone`, `/elevation`, and
`/tiles/:z/:x/:y.pbf` without the Node backend. The deployment builds search shards
from the Sifric index. Search starts with at least two characters of an indexed
name or word. Nearby search supports up to 5 km. Indexed forward and reverse
geocoding are available with place-level precision when a separate geocoder is
absent.

Elevation samples existing Mapzen Terrarium data from AWS Open Data. The tile
API reads vector byte ranges from the existing Sifric R2 archive. These endpoints
use the same developer authentication as the rest of the portal.

The Worker also serves GET `/roads/nearest?lon=79.86&lat=6.92`. It snaps a point
to a road or path centerline from the Sifric basemap. An optional `radius` sets
the maximum distance in meters (1–150; default 75). The response includes the
snapped location, distance, and basemap class. It does not determine access
restrictions, speed limits, or the road a trip followed.

The Worker's `/static-map` uses the Cloudflare Browser Run binding to render
the Default basemap as a PNG with attribution. Pass `lon`, `lat`, and
optionally `width` and `height` (128–1280 px), `zoom`, `pin=1`, and
`theme=light|dark`. Rendering is subject to the account's Browser Run quota.

Share a place search with `/developer/?q=Colombo` or open a pinned location
with `/developer/embed/?lon=79.86&lat=6.92&zoom=15&pin=1`. Both links require
developer access. The public map's existing place sharing uses `/?place=ID`.

The Worker supports POST `/routes` and `/matrix` for `drive`, `walk`, `cycle`,
`motorcycle`, and `tuk`. Motorcycle and tuk-tuk profiles exclude expressways
and marked motor-only roads. Pass coordinates in `[longitude, latitude]` order. Routes accept
2–8 coordinates and return a GeoJSON path with estimated duration in seconds,
distance in meters, and geometry-derived maneuvers. Matrices accept 2–25
coordinates with optional `sources` and `destinations` index arrays. An
unreachable pair is `null`. Coordinates are snapped to routing vertices
within 500 m. The motor vehicle profile accounts for supported OSM one-way
and node-based turn restrictions. Estimates use map data and profile speeds.
Conditional and via-way restrictions are unavailable.

On two-point routes, `alternatives: true` returns up to two additional paths
when the graph has distinct options with a reasonable travel time.
`optimizeWaypointOrder: true` finds the lowest estimated driving or travel
time among orders of up to six intermediate stops. Endpoints stay fixed and
`optimizedIntermediateWaypointIndices` indexes the original intermediate
stops from zero. A route can take `waypoints` in place of `coordinates`,
with each waypoint specified by `{location: [lon, lat]}` or `{placeId: 123}`.
Drive requests can opt into `avoidHighways` or `avoidTolls` when
`GET /capabilities` lists the corresponding profile. Highway avoidance
excludes expressways. Toll avoidance excludes mapped toll roads as well as
expressways. The road graphs already exclude ferries.

POST `/roads/match` accepts 2–25 ordered GPS fixes. It compares candidate
vertices within 100 m and reconstructs a connected path when the observed fixes
support one. Set `speedLimits: true` on a drive route or trace to include
numeric limits explicitly tagged on road segments in OpenStreetMap. Speed spans
reference indexes in the returned geometry; unknown limits are `null`.

POST `/optimize` accepts up to four drive vehicles, ten stops, and six distinct
locations. The insertion heuristic uses the Sifric travel matrix and honors
service times, vehicle and job time windows, capacity vectors, and paired
pickup-delivery precedence. Infeasible jobs are returned under `unassigned`.
If a vehicle has no end location, its route ends at its last assigned stop.

POST `/address/validate` accepts `addressLines`, `locality`, `postalCode` and
optional `countryCode: "LK"`. It normalizes postal details, reports missing or
mismatched fields, and suggests entries from the
[lankapost](https://github.com/AbQaadir/lankapost) postal office directory.
Its precision is the postal town. It reports property type and street-level
deliverability as unknown or unverified.

GET `/places/:id/photos` returns photos for places with an unambiguous link
from OpenStreetMap to Wikimedia Commons or Wikidata. Each photo includes the
thumbnail URL, source page, contributor where available, and reuse license.
Places without imported photos return an empty list.

POST `/geolocate` accepts up to eight Sri Lankan cellular observations in
`cellTowers`. Supply `mobileCountryCode: 413`, `mobileNetworkCode`,
`locationAreaCode` (LAC or TAC), `cellId` (or `newRadioCellId` for 5G), and
`radioType: "gsm"|"wcdma"|"lte"|"nr"` on each observation or at the top level.
The result estimates a location and a coverage radius from the matching
cell centers. A separately provisioned Wi-Fi index can be used as described below. Cell tower
data from [OpenCellID](https://opencellid.org/), licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), is filtered
to Sri Lanka and stored as a local binary index from the
[2026-10-06 snapshot](https://huggingface.co/datasets/yuiseki/opencellid).

Navigation links can prefill the form, for example
`/developer/navigation/?origin=79.8612,6.9271&destination=79.8744,6.903&mode=drive`.
The user starts guidance from the form and grants device location permission.

GET `/bathymetry?lon=79&lat=6.4` samples the nearest grid cell of the
[NOAA/NCEI ETOPO 2022](https://doi.org/10.25921/fd45-gt74) relief grid. It
reports elevation and, for negative elevations, depth below the EGM2008
datum. The 15-arc-second grid is suitable for regional geographic estimates.
It is not nautical chart data.

The `Deploy Sifric Maps datasets` workflow builds mode-specific graphs with
[RoutingKit](https://github.com/RoutingKit/RoutingKit) from Geofabrik's Sri
Lanka OpenStreetMap extract and validates them before uploading to the Maps
R2 bucket. The compact index uses variable-width numeric columns to reduce
Worker memory usage without changing path weights or geometry. Routing data is derived
from [OpenStreetMap contributors under the ODbL](https://www.openstreetmap.org/copyright).
The developer gateway sends each request to its travel profile's private
Cloudflare Worker through a service binding. Deploy those Workers with the
`Deploy private Sifric routing Workers` workflow before the gateway. Their
public and preview URLs are disabled.

## Backend container

Build from the Sifric Maps checkout root, then carry the image to a Sifric-operated
host or private registry. The image includes the Sifric place index and runs
unprivileged. The build excludes the repository history, private Worker assets,
and local credentials.

```sh
docker build --target api -f platform/Dockerfile -t sifric-platform:local .
docker run --rm --env-file /secure/sifric-platform.env -p 127.0.0.1:8788:8788 sifric-platform:local
```

If your build network uses a private TLS CA, pass its certificate as the optional
BuildKit secret `--secret id=npm_ca,src=/path/to/ca.pem`. The certificate
is available only during dependency installation.

Supply the private backend credential at runtime. Set the Worker’s
`SIFRIC_PLATFORM_ORIGIN` to an HTTPS reverse proxy or tunnel to that service;
developer clients continue to use `maps.sifric.workers.dev`. Mount any PMTiles
archive or elevation datasets read-only, and use private endpoints for routing,
geocoding and fleet optimization.

Build the optional `renderer` target for PNG maps. It includes Chromium and
requires a trusted `SIFRIC_WEB_ORIGIN` plus an allowlisted render credential.
Run rendering in an isolated container. Both images use the authenticated
`/api/v1/health` probe from inside the container.

## Private setup

- Store `SIFRIC_DEVELOPER_TOKEN_HASHES` as a Worker secret containing a JSON array
  of lowercase SHA-256 hex hashes. Generate a different random 32-byte base64url
  credential for each developer and revoke access by removing its hash. Share
  credentials via a secure channel. An absent, empty or malformed allowlist
  denies access.
- Use username `sifric` and the assigned token as the browser password at
  `/developer/`. Server clients send `Authorization: Bearer <token>`. Keep
  bearer credentials on developer servers or in a credential store.
- Set `SIFRIC_PLATFORM_ORIGIN` to the fixed HTTPS address of the privately
  operated Node service. Set the same randomly generated `SIFRIC_PLATFORM_TOKEN`
  on the Worker and backend. Use a token distinct from all developer credentials.
- Use same-origin browser requests. The Worker strips upstream CORS headers,
  applies `private, no-store`, and does not send developer credentials to the backend.
  The private iframe is same-origin only. Public web integration needs a separately
  scoped service and review.

## Data and service configuration

- `SIFRIC_PLACE_INDEX` optionally overrides the bundled place-search JSON or gzip file. The service indexes it at startup. Indexed-place results lack house-level guarantees.
- `SIFRIC_OSRM_DRIVE_URL`, `SIFRIC_OSRM_VAN_URL`, `SIFRIC_OSRM_TUK_URL`, `SIFRIC_OSRM_WALK_URL`, `SIFRIC_OSRM_CYCLE_URL`, and `SIFRIC_OSRM_MOTORCYCLE_URL` must point to dedicated OSRM instances or fixed prefixes hosting the matching graphs. OSRM selects behavior from its graph. The HTTP path segment is not a travel-mode selector. There is no public demo endpoint fallback or live traffic feed in this API.
- `SIFRIC_NOMINATIM_URL` points to a self-hosted instance with Sri Lankan address coverage. `SIFRIC_VROOM_URL` points to the exact private VROOM HTTP endpoint, which should use the corresponding private routing graphs.
- `SIFRIC_PMTILES_PATH` points to a vector archive from the existing map release. `SIFRIC_ELEVATION_DIR` contains uncompressed 1201×1201 or 3601×3601 SRTM HGT tiles. SRTM covers land elevation. Ocean depth needs separate bathymetry data.
- `SIFRIC_WEB_ORIGIN`, `SIFRIC_CHROMIUM`, and a dedicated allowlisted `SIFRIC_RENDER_TOKEN` enable server-side PNG rendering from a trusted Sifric Worker origin and an installed Chromium executable. Run the renderer in an isolated service as an unprivileged user.
- `HOST` and `PORT` default to `127.0.0.1` and `8788`. Place the API behind appropriate authentication, quotas, and logging controls before allowing public access, especially for locations, routing, and rendering.

## Embed and SDK

```html
<iframe
  src="/developer/embed/?lon=79.86&lat=6.93&zoom=13&pin=1"
  title="Pickup map" width="640" height="480" loading="lazy">
</iframe>
```

Use the same link outside an iframe to share a map location. The embed defaults to
the Default map and follows the device theme. Add `type=default|satellite|terrain`
and `theme=system|light|dark` to preselect the view and theme. The appearance
controls are hidden by default. Add `controls=1` to show the selector. Satellite imagery retains its natural colors
in both themes.

```js
import { createSifricMap } from "/developer/sifric-maps.js";

const map = await createSifricMap("map", { center: [79.86, 6.93], zoom: 13 });
// map is a MapLibre instance. Add your own sources, markers, and layers.
```

For a Web Places picker, load `/developer/sifric-places.js` as a module and use
`<sifric-place-search api-base="https://maps.sifric.workers.dev"></sifric-place-search>`.
Listen for `sifric-place-select` to receive the chosen place record. The SDK
also exports `createSifricClient(apiBase)` for search, details, nearby places,
routing and matrix requests.

## Browser navigation

Open `/developer/navigation/` from the authenticated portal. Choose the
origin, destination and mode, then start guidance and grant location permission.
The selected mode needs its own configured OSRM graph. Only the origin,
destination and reroute points are sent to the route service. Normal GPS fixes
are processed in the browser. The navigation UI requires an active browser tab
and a secure context. Its remaining time estimate uses route duration and does
not include live traffic.

For same-origin applications, import `createSifricNavigation` and
`formatSifricManeuver` from `/developer/sifric-navigation.js`. Supply a
`createSifricClient(location.origin)` client and an `onUpdate` callback.
Call `start({ origin, destination, mode })` and `stop()` when leaving the page.
Events include `route`, `progress`, `off-route`, `rerouting`, `arrived`,
`error` and `location-error`. Navigation currently supports a single
destination and needs a field-tested graph before production guidance.

## Implementation boundaries

The native Android/iOS SDKs, native turn-by-turn navigation SDKs, native Places UI components, panorama capture/publishing and browsing, photorealistic 3D and aerial video, live traffic/transit, crowdsourced reviews, cell/Wi-Fi positioning, and postal-grade address validation require additional implementations and/or data. The current API does not fabricate these results.

## Transit, mapped premises, Wi-Fi, and traffic

`POST /transit/routes` plans trips on published Lanka Metro Transit schedules.
Send two `coordinates` and an optional ISO `departureTime` with a time-zone
offset. Walking estimates between a coordinate and a stop are straight-line.
The service respects scheduled dates, stop access, and a two-minute minimum
same-stop transfer. A recurring dataset build imports the available published
dates. Timetable coverage is limited to the operator's available feed.

Address validation also accepts `houseNumber` and `street`. A matching number,
street and postal area in OpenStreetMap produces `mapped-premise` precision
and a residential or commercial classification when tagged in the map.
Deliverability remains unverified.

The private geolocation endpoint accepts `wifiAccessPoints` containing
`macAddress` observations. The system needs at least three matching access
points in an authorized index. Use `scripts/build_wifi_index.mjs INPUT OUTPUT`
to build an index privately from authorized observations with `longitude`,
`latitude`, and `radiusMeters`, then publish to
`lkmaps/geolocation/v1/wifi.json` in the Maps R2 bucket. Keep raw inputs outside
Git. Wi-Fi observations are not forwarded to an external service. When provided
with the request, cellular observations can supply an estimate if Wi-Fi coverage
is insufficient.

Supply `trafficAware: true` to `POST /routes` to include observed-segment delay
in motor vehicle estimates. Publish a validated observation file to
`lkmaps/traffic/v1/current.json` in the Maps R2 bucket. The object includes
`observedAt`, `source`, and up to 32 directed `segments`, each with `from`,
`to`, `factor`, and `closed`. Run `node scripts/check_traffic_snapshot.mjs FILE`
before publishing. The Worker accepts observations at most 15 minutes old.
Traffic-aware two-point requests compare available route candidates when there
is a current snapshot. Closed candidates are removed and candidates are ordered
by estimated duration. A closure on every available candidate returns HTTP
409. Coverage varies by segment. Without fresh data, the response reports
`unavailable` and keeps the base estimates.
