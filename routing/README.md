# OSRM REST routing

The maps Worker sends route requests through the internal `lkmaps-router` service binding.
The router calls public OSRM REST services and does not deploy or run a routing container.

## Profiles and providers

- Drive and two-wheeler use OSRM's driving profile. The router tries `router.project-osrm.org`
  first, then FOSSGIS's `routed-car` endpoint if the first service is unavailable.
- Walk uses FOSSGIS's dedicated `routed-foot` endpoint. The Project OSRM demo's walking URL
  returned the same driving result in a live check, so it is not used as a walking fallback.
- Walking currently has one verified public foot backend; if it is down, the router returns a
  retryable error rather than substituting a driving route.
- The router serializes calls per provider hostname and enforces the public services' one-request-
  per-second limits. Identical routing requests are not cached.

These are shared community services, not an SLA-backed production routing service. Their operators
may throttle or deny requests, and route requests can be recorded by the provider. The router returns
a retryable error when a provider is unavailable or too many requests are queued. Do not use the
public demos for heavy or commercial traffic.

## Free-tier deployment

`lkmaps-router` uses a Worker and a SQLite-backed Durable Object only; it has no Container binding
and requires no container-capable or paid Workers plan. Cloudflare's free Worker and Durable Object
quotas still apply. The deploy workflow publishes `lkmaps-router` before `maps`.

Routing uses OpenStreetMap road data. Attribute the data to © OpenStreetMap contributors and observe
the ODbL.
