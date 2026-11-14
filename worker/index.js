import basemapStyle from "./style.json";

const TILE_KEY = "lkmaps/sri-lanka.pmtiles";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
    if (url.pathname === "/style.json") {
      const style = structuredClone(basemapStyle);
      delete style.sources.openmaptiles.tiles;
      style.sources.openmaptiles.url = `pmtiles://${url.origin}/tiles/sri-lanka.pmtiles`;
      style.sprite = `${url.origin}/api/v1/basemap/sprite`;
      style.glyphs = `${url.origin}/api/v1/fonts/{fontstack}/{range}.pbf`;
      return new Response(request.method === "HEAD" ? null : JSON.stringify(style), {
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
