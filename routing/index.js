import { DurableObject } from "cloudflare:workers";

const MAX_QUEUE_MS = 5_000;
const PROVIDER_INTERVAL_MS = 1_100;
const UPSTREAM_TIMEOUT_MS = 8_000;
const COORDINATE_PATTERN = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?);(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
const PROVIDERS = {
  driving: [
    {
      host: "router.project-osrm.org",
      base: "https://router.project-osrm.org",
      prefix: "",
    },
    {
      host: "routing.openstreetmap.de",
      base: "https://routing.openstreetmap.de",
      prefix: "/routed-car",
    },
  ],
  // The main OSRM demo server returns its prepared default profile even when the URL says
  // "walking". FOSSGIS has a dedicated foot profile selected by the routed-foot path.
  walking: [
    {
      host: "routing.openstreetmap.de",
      base: "https://routing.openstreetmap.de",
      prefix: "/routed-foot",
    },
  ],
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    const match = url.pathname.match(/^\/route\/v1\/(driving|walking)\/(.+)$/);
    if (!match) return new Response("Not Found", { status: 404 });

    const id = env.OSRM.idFromName("sri-lanka");
    return env.OSRM.get(id).fetch(request);
  },
};

// Keep the export name stable: this class name is part of the Worker's Durable Object identity.
// It now coordinates requests to public OSRM REST endpoints; it does not start a container.
export class OsrmFallbackContainer extends DurableObject {
  async fetch(request) {
    const incoming = new URL(request.url);
    const match = incoming.pathname.match(/^\/route\/v1\/(driving|walking)\/(.+)$/);
    if (request.method !== "GET" || !match) {
      return jsonResponse({ code: "InvalidRequest", message: "Unsupported routing request." }, 404);
    }

    const [, profile, coordinates] = match;
    if (!validSriLankaCoordinates(coordinates)) {
      return jsonResponse({ code: "InvalidQuery", message: "Route coordinates must be inside Sri Lanka." }, 400);
    }

    const providers = PROVIDERS[profile];
    const attempted = new Set();
    let lastNoRoute;
    let lastRetryAfter;

    for (let i = 0; i < providers.length; i += 1) {
      const remaining = providers.filter((provider) => !attempted.has(provider.host));
      if (!remaining.length) break;

      const slot = await this.reserveProvider(remaining);
      if (!slot) {
        return jsonResponse(
          { code: "RateLimited", message: "Routing is busy. Retry shortly." },
          429,
          { "Retry-After": "5" },
        );
      }
      attempted.add(slot.provider.host);
      if (slot.waitMs > 0) await sleep(slot.waitMs);

      const target = new URL(slot.provider.base);
      target.pathname = `${slot.provider.prefix}/route/v1/driving/${coordinates}`;
      for (const [key, value] of incoming.searchParams) {
        if (["steps", "overview", "geometries", "alternatives"].includes(key)) {
          target.searchParams.set(key, value);
        }
      }

      try {
        const response = await fetch(target, {
          headers: {
            Accept: "application/json",
            "User-Agent": "LK Maps routing (https://maps.mazo.workers.dev/)",
            Referer: "https://maps.mazo.workers.dev/",
          },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        let result;
        try {
          result = await response.json();
        } catch {
          continue;
        }

        if (response.ok && result.code === "Ok") {
          return jsonResponse(result, 200);
        }
        if (result.code === "NoRoute" || result.code === "NoSegment") lastNoRoute = result;
        if (response.status === 429) lastRetryAfter = response.headers.get("Retry-After") || "5";
        console.warn("OSRM provider returned an unusable response", slot.provider.host, response.status, result.code || "unknown");
      } catch {
        console.warn("OSRM provider request failed", slot.provider.host);
        // Try the next provider when one is configured for this profile.
      }
    }

    if (lastNoRoute) return jsonResponse(lastNoRoute, 200);
    if (lastRetryAfter) {
      return jsonResponse(
        { code: "RateLimited", message: "The routing provider is busy. Retry shortly." },
        429,
        { "Retry-After": lastRetryAfter },
      );
    }
    return jsonResponse(
      { code: "ServiceUnavailable", message: "Public OSRM routing is temporarily unavailable." },
      502,
    );
  }

  async reserveProvider(providers) {
    const now = Date.now();
    return this.ctx.storage.transaction(async (txn) => {
      let choice;
      for (const provider of providers) {
        const nextAllowedAt = (await txn.get(`next:${provider.host}`)) || 0;
        if (!choice || nextAllowedAt < choice.nextAllowedAt) {
          choice = { provider, nextAllowedAt };
        }
      }
      const slotAt = Math.max(now, choice.nextAllowedAt);
      const waitMs = slotAt - now;
      if (waitMs > MAX_QUEUE_MS) return null;
      await txn.put(`next:${choice.provider.host}`, slotAt + PROVIDER_INTERVAL_MS);
      return { provider: choice.provider, waitMs };
    });
  }
}

function validSriLankaCoordinates(value) {
  const match = value.match(COORDINATE_PATTERN);
  if (!match) return false;
  const points = [
    [Number(match[1]), Number(match[2])],
    [Number(match[3]), Number(match[4])],
  ];
  return points.every(([longitude, latitude]) =>
    Number.isFinite(longitude) && Number.isFinite(latitude) &&
    longitude >= 78 && longitude <= 82.5 && latitude >= 5 && latitude <= 10.5,
  );
}

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...extraHeaders },
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
