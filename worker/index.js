/**
 * Cloudflare Worker – serves PMTiles from R2 with Range support,
 * and a MapLibre style.json with a places symbol layer.
 *
 * Routes
 * ------
 * GET /tiles/places-<sha8>.pmtiles  → R2, long cache, Range support
 * GET /style.json                   → dynamic style, short cache
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Expose-Headers":
        "Content-Range, Content-Length, Accept-Ranges",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // ── /tiles/places-<sha8>.pmtiles ──────────────────────────────
    const tileMatch = path.match(
      /^\/tiles\/(places-[a-f0-9]{8}\.pmtiles)$/,
    );
    if (tileMatch) {
      return serveTile(request, env, tileMatch[1], cors);
    }

    // ── /style.json ───────────────────────────────────────────────
    if (path === "/style.json") {
      return serveStyle(env, url, cors);
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ── tile handler (R2 + Range) ─────────────────────────────────────
async function serveTile(request, env, key, cors) {
  const rangeHeader = request.headers.get("Range");
  const options = {};

  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const offset = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : undefined;
      options.range = {
        offset,
        length: end !== undefined ? end - offset + 1 : undefined,
      };
    }
  }

  const object = await env.TILES_BUCKET.get(key, options);
  if (!object) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = {
    ...cors,
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: object.httpEtag,
  };

  if (rangeHeader && object.range) {
    const { offset, length } = object.range;
    headers["Content-Range"] =
      `bytes ${offset}-${offset + length - 1}/${object.size}`;
    headers["Content-Length"] = String(length);
    return new Response(object.body, { status: 206, headers });
  }

  headers["Content-Length"] = String(object.size);
  return new Response(object.body, { status: 200, headers });
}

// ── style handler ─────────────────────────────────────────────────
async function serveStyle(env, url, cors) {
  const manifest = await env.TILES_BUCKET.get("manifest.json");
  if (!manifest) {
    return new Response("Manifest not found", { status: 500 });
  }

  const { sha8 } = await manifest.json();
  const base = `${url.protocol}//${url.host}`;
  const tilesUrl = `pmtiles://${base}/tiles/places-${sha8}.pmtiles`;

  const style = {
    version: 8,
    name: "LK Maps Places",
    sources: {
      places: {
        type: "vector",
        url: tilesUrl,
      },
    },
    layers: [
      {
        id: "places-label",
        type: "symbol",
        source: "places",
        "source-layer": "places",
        minzoom: 0,
        layout: {
          "text-field": ["get", "name"],
          "text-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5, 9,
            14, 14,
          ],
          "text-anchor": "top",
          "text-offset": [0, 0.6],
          "icon-image": "marker",
          "icon-size": 0.5,
          "icon-allow-overlap": false,
          "text-allow-overlap": false,
          "text-optional": true,
          "symbol-sort-key": ["get", "priority"],
        },
        paint: {
          "text-color": "#333333",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      },
    ],
  };

  return new Response(JSON.stringify(style, null, 2), {
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}
