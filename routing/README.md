# OSRM routing fallback

The maps Worker calls the public OSRM REST API first. The dedicated `lkmaps-router`
Worker allows at most one request per second to the public demo endpoint across all
requests. When that endpoint is throttled, unavailable, or cannot calculate the selected
profile, the router falls back to OSRM running in a Cloudflare Container managed by a
Durable Object. Requests stay behind the maps Worker's `/api/v1/route` endpoint.

The public OSRM demo is shared community infrastructure, has no uptime guarantee, and
is subject to its usage policy. It should not be treated as a production SLA. The
request cap is enforced in Durable Object storage; excess requests immediately use the
self-hosted fallback instead of sending more traffic to the public service.

## Fallback behavior

The container starts only when the public service cannot serve a request. On first
start it downloads the Sri Lanka OpenStreetMap PBF from Geofabrik, verifies the
published MD5, then prepares OSRM Multi-Level Dijkstra data for `car.lua` and
`foot.lua`. A healthy graph is snapshotted so subsequent container starts can restore
the prepared data. The first fallback request can return HTTP 503 while the container
downloads and preprocesses the extract; retry after `Retry-After`.

Drive and two-wheeler requests use OSRM's `driving` service/profile; two-wheeler is a
driving-profile approximation. Walk uses `walking`. The public OSRM demo typically
serves driving only, so walk requests use the self-hosted fallback.

Cloudflare Container fallback requires a Workers plan with Containers enabled and a
`standard-2` instance (1 vCPU, 6 GiB memory, 12 GB disk) for graph preparation and serving.
The deploy workflow deploys
`lkmaps-router` before `maps`. No API token or public routing hostname is needed by
the route code; the deploy workflow supplies its existing Cloudflare secrets.

## Local fallback

The included Compose setup can run the same OSRM fallback locally. It uses the same
first-start download and preprocessing behavior and exposes the driving and walking
engines on localhost ports 5000 and 5001. To route the maps Worker directly to a local
OSRM server, set `ROUTING_URL` in the ignored `worker/.dev.vars` file to the local
server URL. The production maps Worker uses the internal service binding instead.

Routing uses OpenStreetMap road data. Attribute the data to © OpenStreetMap
contributors and observe the ODbL.
