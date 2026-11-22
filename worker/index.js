import basemapStyle from "./style.json";
import { nativeStyle } from "./native-style.mjs";


import { createPlatformApi } from "./platform-api.mjs";
import { renderStaticMap } from "./static-map.mjs";
import { createPrivateGateway } from "./private-gateway.mjs";
import portal from "./private/portal.html.txt";
import portalScript from "./private/portal.js.txt";
import nativeSdkGuide from "./private/native-sdk.html.txt";
import apiReference from "./private/api-reference.html.txt";
import embed from "./private/embed.html.txt";
import embedScript from "./private/embed.js.txt";
import embedStyle from "./private/embed.css.txt";
import mapsSdk from "./private/sifric-maps.js.txt";
import placesSdk from "./private/sifric-places.js.txt";
import navigation from "./private/navigation.html.txt";
import navigationScript from "./private/navigation.js.txt";
import navigationStyle from "./private/navigation.css.txt";
import navigationSdk from "./private/sifric-navigation.js.txt";
import rideNowAdapter from "./private/ridenow-maps.mjs.txt";

const TILE_KEY = "lkmaps/sri-lanka.pmtiles";
const handleDeveloper = createPrivateGateway(new Map([
  ["/developer", [portal, "text/html; charset=utf-8"]],
  ["/developer/", [portal, "text/html; charset=utf-8"]],
  ["/developer/portal.js", [portalScript, "text/javascript; charset=utf-8"]],
  ["/developer/native-sdk/", [nativeSdkGuide, "text/html; charset=utf-8"]],
  ["/developer/api-reference/", [apiReference, "text/html; charset=utf-8"]],
  ["/developer/embed/", [embed, "text/html; charset=utf-8"]],
  ["/developer/embed.js", [embedScript, "text/javascript; charset=utf-8"]],
  ["/developer/embed.css", [embedStyle, "text/css; charset=utf-8"]],
  ["/developer/sifric-maps.js", [mapsSdk, "text/javascript; charset=utf-8"]],
  ["/developer/sifric-places.js", [placesSdk, "text/javascript; charset=utf-8"]],
  ["/developer/navigation/", [navigation, "text/html; charset=utf-8"]],
  ["/developer/navigation/navigation.js", [navigationScript, "text/javascript; charset=utf-8"]],
  ["/developer/navigation/navigation.css", [navigationStyle, "text/css; charset=utf-8"]],
  ["/developer/sifric-navigation.js", [navigationSdk, "text/javascript; charset=utf-8"]],
  ["/developer/ridenow-maps.mjs", [rideNowAdapter, "text/javascript; charset=utf-8"]],
]), createPlatformApi(TILE_KEY, renderStaticMap));
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  "Access-Control-Max-Age": "86400",
};
const routeCors = {
  ...cors,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const DEFAULT_OSRM_ORIGIN = "https://router.project-osrm.org";
const FALLBACK_OSRM_ORIGINS = { drive: "https://routing.openstreetmap.de/routed-car", twoWheeler: "https://routing.openstreetmap.de/routed-car", walk: "https://routing.openstreetmap.de/routed-foot" };
let lastOsrmRequestAt = 0;
let osrmRequestQueue = Promise.resolve();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path;
    try { path = decodeURIComponent(url.pathname); }
    catch { return new Response("Not Found", { status: 404 }); }
    if (/(?:^|\/)_sifric_index(?:\/|$)/i.test(path)) {
      return new Response("Not Found", { status: 404 });
    }
    if (url.pathname === "/developer" || url.pathname.startsWith("/developer/")) {
      return handleDeveloper(request, env, url.pathname);
    }

    // Standalone UI-only developer demo; no authentication or API keys are enforced.
    if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
      if (!["GET", "HEAD"].includes(request.method)) return new Response("Method Not Allowed", { status: 405 });
      const asset = await env.ASSETS.fetch(new Request(new URL("/developers.html", request.url), request));
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; font-src https://sifric.github.io; img-src 'self' data: https://sifric.github.io https://github.com https://avatars.githubusercontent.com; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
      return new Response(request.method === "HEAD" ? null : asset.body, { status: asset.status, headers });
    }
    if (url.pathname === "/api/v1/route") {
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: routeCors });
      if (request.method !== "POST")
        return jsonResponse({ error: "Method Not Allowed" }, 405, routeCors);
      return routeRequest(request, env);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }
    if (url.pathname === "/favicon.ico") {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status === 404) return asset;
      const response = new Response(asset.body, asset);
      response.headers.set("Content-Type", "image/x-icon");
      response.headers.set("Cache-Control", "public, max-age=86400");
      return response;
    }
    if (url.pathname === "/.well-known/assetlinks.json" || url.pathname === "/.well-known/apple-app-site-association") {
      const name = url.pathname.slice("/.well-known/".length);
      const file = await env.TILES_BUCKET.get("lkmaps/sdk/v1/associations/" + name);
      if (!file || file.size > 65536) return new Response("Not Found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : file.body, {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
      });
    }
    if (url.pathname === "/style.json" || url.pathname === "/api/v1/native-style.json") {
      const style = structuredClone(basemapStyle);
      delete style.sources.openmaptiles.tiles;
      style.sources.openmaptiles.url = `pmtiles://${url.origin}/tiles/sri-lanka.pmtiles`;
      style.sprite = `${url.origin}/api/v1/basemap/sprite`;
      style.glyphs = `${url.origin}/api/v1/fonts/{fontstack}/{range}.pbf`;
      const output = url.pathname === "/style.json" ? style : nativeStyle(style, url.searchParams);
      if (!output) return new Response("Invalid native map appearance.", { status: 400, headers: cors });
      return new Response(request.method === "HEAD" ? null : JSON.stringify(output), {
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }
    if (url.pathname === "/tiles/sri-lanka.pmtiles") {
      return serveTile(request, env);
    }
    const sprite = url.pathname.match(/^\/api\/v1\/basemap\/sprite(@2x)?\.(json|png)$/);
    if (sprite) {
      return serveAsset(request, env, `/assets/sprites/basemap${sprite[1] || ""}.${sprite[2]}`);
    }
    const glyph = url.pathname.match(/^\/api\/v1\/fonts\/([^/]+)\/(\d+-\d+\.pbf)$/);
    if (glyph) {
      const [start, end] = glyph[2].slice(0, -4).split("-").map(Number);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end - start !== 255) {
        return new Response("Not Found", { status: 404, headers: cors });
      }
      let stack;
      try { stack = decodeURIComponent(glyph[1]); }
      catch { return new Response("Not Found", { status: 404, headers: cors }); }
      if (stack.includes("/") || stack.includes("\\") || stack === "." || stack === "..") {
        return new Response("Not Found", { status: 404, headers: cors });
      }
      const asset = await serveAsset(request, env, `/assets/fonts/${encodeURIComponent(stack)}/${glyph[2]}`);
      if (asset.status === 404) {
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: {
            "Content-Type": "application/x-protobuf",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
      return asset;
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/tiles/")) {
      return new Response("Not Found", { status: 404, headers: cors });
    }
    return assetResponse(await env.ASSETS.fetch(request), url.pathname);
  },
};

async function routeRequest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Expected a JSON route request." }, 400, routeCors);
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return jsonResponse({ error: "Expected a JSON route request." }, 400, routeCors);
  // OSRM profiles are selected when the graph is built; a URL segment alone does not switch graphs.
  const modes = { drive: "driving", twoWheeler: "driving", walk: "walking" };
  const profile = modes[body.mode];
  const validPoint = (point) =>
    Array.isArray(point) && point.length === 2 &&
    point.every((value) => typeof value === "number" && Number.isFinite(value)) &&
    point[0] >= 78 && point[0] <= 82.5 && point[1] >= 5 && point[1] <= 10.5;
  if (!profile)
    return jsonResponse({ error: "Choose Drive, Two-wheeler, or Walk." }, 400, routeCors);
  if (!validPoint(body.origin) || !validPoint(body.destination))
    return jsonResponse({ error: "Origin and destination must be coordinates in Sri Lanka." }, 400, routeCors);

  let endpoint;
  try {
    const origin = (body.mode === "walk" && env.OSRM_WALK_URL) || env.OSRM_BASE_URL || DEFAULT_OSRM_ORIGIN;
    endpoint = new URL(origin);
    if (!["https:", "http:"].includes(endpoint.protocol)) throw new Error("Invalid OSRM URL");
    const coordinates = [body.origin, body.destination]
      .map(([longitude, latitude]) => `${longitude},${latitude}`)
      .join(";");
    // Preserve a configured OSRM base path (e.g. /routed-car).
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/route/v1/${profile}/${coordinates}`;
    endpoint.search = "";
    endpoint.searchParams.set("steps", "true");
    endpoint.searchParams.set("overview", "full");
    endpoint.searchParams.set("geometries", "geojson");
  } catch {
    return jsonResponse({ error: "Could not build the OSRM routing request." }, 500, routeCors);
  }

  try {
    const configured = Boolean((body.mode === "walk" && env.OSRM_WALK_URL) || env.OSRM_BASE_URL);
    const candidates = [endpoint];
    // The public OSRM demo may return an HTML denial/rate-limit page to Worker traffic.
    // Only use the alternative public instance when no dedicated server was configured.
    if (!configured) {
      const fallback = new URL(FALLBACK_OSRM_ORIGINS[body.mode]);
      fallback.pathname = (fallback.pathname.endsWith("/") ? fallback.pathname.slice(0, -1) : fallback.pathname) + `/route/v1/${profile}/${[body.origin, body.destination].map(([lon, lat]) => `${lon},${lat}`).join(";")}`;
      fallback.search = endpoint.search;
      candidates.push(fallback);
    }
    let failure = "The routing service is unavailable.";
    for (const [index, candidate] of candidates.entries()) {
      const upstreamRequest = new Request(candidate.toString(), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      const upstream = configured ? await fetch(upstreamRequest) : await fetchPublicOsrm(upstreamRequest);
      const raw = await upstream.text();
      let result;
      try { result = JSON.parse(raw); }
      catch {
        failure = `Routing server returned a non-JSON response (HTTP ${upstream.status}).`;
        if (index + 1 < candidates.length) continue;
        if (upstream.status === 403) failure = "Public OSRM servers denied requests from this Worker (HTTP 403). Configure a dedicated OSRM_BASE_URL for reliable routing.";
        return jsonResponse({ error: failure }, 502, routeCors);
      }
      if (!upstream.ok || result.code !== "Ok") {
        if (upstream.status === 403 && index + 1 < candidates.length) continue;
        if (upstream.status === 403) return jsonResponse({ error: "OSRM server denied this Worker (HTTP 403). Configure a dedicated OSRM_BASE_URL." }, 502, routeCors);
        if (upstream.status === 429) {
          failure = result.message || "Routing is busy. Retry shortly.";
          if (index + 1 < candidates.length) continue;
          return jsonResponse({ error: failure }, 429, { ...routeCors, "Retry-After": upstream.headers.get("Retry-After") || "5" });
        }
        const warming = upstream.status === 503;
        failure = result.message || (warming ? "The routing engine is starting. Retry shortly." : "The routing service could not find a route.");
        if (upstream.status >= 500 && index + 1 < candidates.length) continue;
        return jsonResponse({ error: failure }, warming ? 503 : upstream.status >= 500 ? 502 : 422, routeCors);
      }
      const route = result.routes?.[0];
      if (!route?.geometry?.coordinates?.length)
        return jsonResponse({ error: result.message || "No route was found." }, 422, routeCors);
      return jsonResponse({
        geometry: route.geometry,
        distance: route.distance,
        duration: route.duration,
        steps: (route.legs || []).flatMap((leg) => leg.steps || []).map(osrmStep),
      }, 200, routeCors);
    }
    return jsonResponse({ error: failure }, 502, routeCors);
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return jsonResponse(
      { error: timedOut ? "The routing request timed out." : "Could not reach the routing service." },
      timedOut ? 504 : 502,
      routeCors,
    );
  }
}

function fetchPublicOsrm(request) {
  const send = async () => {
    const delay = 1000 - (Date.now() - lastOsrmRequestAt);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    lastOsrmRequestAt = Date.now();
    return fetch(request);
  };
  const pending = osrmRequestQueue.then(send, send);
  osrmRequestQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

function osrmStep(step) {
  const maneuver = step.maneuver || {};
  const modifier = maneuver.modifier ? ` ${maneuver.modifier}` : "";
  const actions = {
    depart: "Start",
    arrive: "Arrive at your destination",
    turn: `Turn${modifier}`,
    continue: `Continue${modifier}`,
    merge: `Merge${modifier}`,
    fork: `Keep${modifier}`,
    on_ramp: "Take the ramp",
    off_ramp: "Take the exit",
    roundabout: "Enter the roundabout",
    rotary: "Enter the rotary",
    end_of_road: `At the end of the road, turn${modifier}`,
    new_name: "Continue",
    notification: "Continue",
  };
  const action = actions[maneuver.type] || "Continue";
  return {
    text: step.name ? `${action} onto ${step.name}` : action,
    distance: step.distance || 0,
  };
}

function jsonResponse(value, status, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function serveTile(request, env) {
  const metadata = await env.TILES_BUCKET.head(TILE_KEY);
  if (!metadata) return new Response("Not Found", { status: 404, headers: cors });
  const headers = {
    ...cors,
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    ETag: metadata.httpEtag,
  };
  const range = request.headers.get("Range");
  let offset = 0;
  let length = metadata.size;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let end;
    if (match && (match[1] || match[2])) {
      if (!match[1]) {
        length = Math.min(Number(match[2]), metadata.size);
        offset = metadata.size - length;
      } else {
        offset = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), metadata.size - 1) : metadata.size - 1;
        length = end - offset + 1;
      }
    }
    if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) || offset < 0 || offset >= metadata.size || length <= 0) {
      return new Response(null, {
        status: 416, headers: { ...headers, "Content-Range": `bytes */${metadata.size}` },
      });
    }
    headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${metadata.size}`;
  }
  headers["Content-Length"] = String(length);
  const status = range ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const object = await env.TILES_BUCKET.get(TILE_KEY, {
    ...(range ? { range: { offset, length } } : {}),
    onlyIf: { etagMatches: metadata.etag },
  });
  if (!object) return new Response("Not Found", { status: 404, headers: cors });
  if (!("body" in object)) return new Response(null, { status: 412, headers: cors });
  return new Response(object.body, { status, headers });
}

async function serveAsset(request, env, pathname) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = pathname;
  assetUrl.search = "";
  const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  return assetResponse(asset, pathname);
}

function assetResponse(asset, pathname) {
  const response = new Response(asset.body, asset);
  if (pathname.endsWith(".pbf")) response.headers.set("Content-Type", "application/x-protobuf");
  else if (pathname.endsWith(".json")) response.headers.set("Content-Type", "application/json");
  else if (pathname.endsWith(".png")) response.headers.set("Content-Type", "image/png");
  else if (!response.headers.has("Content-Type")) {
    response.headers.set("Content-Type", pathname.endsWith(".html") || pathname.endsWith("/")
      ? "text/html; charset=utf-8" : "application/octet-stream");
  }
  for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
  return response;
}

// Temporary: keeps the legacy Durable Object class exported so deploy is not blocked.
// Remove only after a delete-class migration is applied with the correct remote tag.
export class LiveDataRegistry {
  async fetch() {
    return new Response("Gone", { status: 410 });
  }
}
