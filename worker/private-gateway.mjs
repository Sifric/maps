const encoder = new TextEncoder();

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
};

function credential(header) {
  const bearer = /^Bearer ([A-Za-z0-9_-]{43,128})$/i.exec(header)?.[1];
  if (bearer) return bearer;
  const basic = /^Basic ([A-Za-z0-9+/=]{1,256})$/i.exec(header)?.[1];
  if (!basic) return null;
  try {
    return /^sifric:([A-Za-z0-9_-]{43,128})$/.exec(atob(basic))?.[1] ?? null;
  } catch {
    return null;
  }
}

async function authorized(request, config) {
  let hashes;
  try { hashes = JSON.parse(config); } catch { return false; }
  if (!Array.isArray(hashes) || hashes.length < 1 || hashes.length > 100 ||
      !hashes.every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) return false;

  const token = credential(request.headers.get("Authorization") ?? "");
  if (!token) return false;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))),
    byte => byte.toString(16).padStart(2, "0")).join("");
  let matched = 0;
  for (const hash of hashes) {
    let difference = 0;
    for (let i = 0; i < 64; i++) difference |= hash.charCodeAt(i) ^ digest.charCodeAt(i);
    matched |= Number(difference === 0);
  }
  return matched === 1;
}

export function createPrivateGateway(assets, localApi) {
  return async function privateGateway(request, env, path, send = fetch) {
    if (!env.SIFRIC_DEVELOPER_TOKEN_HASHES) {
      return new Response("Not found", { status: 404, headers: privateHeaders });
    }
    if (!(await authorized(request, env.SIFRIC_DEVELOPER_TOKEN_HASHES))) {
      return new Response("Authentication required", { status: 401, headers: {
        ...privateHeaders, "WWW-Authenticate": 'Basic realm="Sifric Maps", charset="UTF-8"',
      } });
    }
    const asset = assets.get(path);
    const origin = request.headers.get("Origin");
    const documentLink = request.method === "GET" &&
      asset?.[1].split(";")[0] === "text/html" &&
      request.headers.get("Sec-Fetch-Mode") === "navigate" &&
      request.headers.get("Sec-Fetch-Dest") === "document";
    if ((origin && origin !== new URL(request.url).origin) ||
        (request.headers.get("Sec-Fetch-Site") === "cross-site" && !documentLink)) {
      return new Response("Cross-site requests are unavailable", { status: 403, headers: privateHeaders });
    }
    if (asset) {
      if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: privateHeaders });
      const [body, type] = asset;
      const headers = { ...privateHeaders, "Content-Type": type };
      if (path === "/developer/embed/") {
        headers["Content-Security-Policy"] = headers["Content-Security-Policy"].replace(
          "connect-src 'self'",
          "connect-src 'self' https://services.arcgisonline.com https://s3.amazonaws.com/elevation-tiles-prod/",
        );
      }
      return new Response(request.method === "HEAD" ? null : body, {
        headers,
      });
    }
    if (!/^\/developer\/api\/v1\/[a-z0-9./_-]+$/u.test(path)) {
      return new Response("Not found", { status: 404, headers: privateHeaders });
    }
    if (!["GET", "HEAD", "POST"].includes(request.method)) {
      return new Response(null, { status: 405, headers: privateHeaders });
    }
    if (request.method === "POST" &&
        !/^application\/json(?:\s*;|$)/iu.test(request.headers.get("Content-Type") ?? "")) {
      return Response.json({ error: "Use application/json." }, { status: 415, headers: privateHeaders });
    }
    const local = await localApi?.(request, env, path);
    if (local) {
      const type = local.headers.get("Content-Type") ?? "application/octet-stream";
      return new Response(local.body, {
        status: local.status,
        headers: { ...privateHeaders, "Content-Type": type },
      });
    }
    try {
      const origin = new URL(env.SIFRIC_PLATFORM_ORIGIN);
      if (origin.protocol !== "https:" || origin.username || origin.password ||
          !/^[A-Za-z0-9_-]{43,128}$/.test(env.SIFRIC_PLATFORM_TOKEN ?? "")) throw new Error();
      const endpoint = new URL(path.slice("/developer".length), origin);
      endpoint.search = new URL(request.url).search;
      const body = request.method === "POST" ? request.body : null;
      const headers = { "Authorization": `Bearer ${env.SIFRIC_PLATFORM_TOKEN}` };
      if (body) headers["Content-Type"] = request.headers.get("Content-Type") ?? "application/json";
      const upstream = await send(endpoint, {
        method: request.method, headers, body, duplex: "half", redirect: "error",
        signal: AbortSignal.timeout(55000),
      });
      const type = upstream.headers.get("Content-Type") ?? "application/octet-stream";
      if (!/^(application\/(json|octet-stream|vnd\.mapbox-vector-tile)|image\/png)(?:;|$)/i.test(type)) {
        throw new Error();
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { ...privateHeaders, "Content-Type": type },
      });
    } catch {
      return Response.json({ error: "Sifric platform service unavailable." }, { status: 503, headers: privateHeaders });
    }
  };
}
