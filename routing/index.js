import { DurableObject } from "cloudflare:workers";

const DEMO_ORIGIN = "https://router.project-osrm.org";
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const INSTANCE_TYPE = "standard-2";
const SNAPSHOT_VERSION = "osrm-v6-sri-lanka-car-foot-2026-11-16";
const PROFILE_PORT = { driving: 5000, walking: 5001 };
const HEALTH_PATH = {
  driving: "/route/v1/car/79.86,6.93;79.87,6.94?overview=false&steps=false",
  walking: "/route/v1/foot/79.86,6.93;79.87,6.94?overview=false&steps=false",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/route\/v1\/(driving|walking)\//);
    if (!match) return new Response("Not Found", { status: 404 });
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    const id = env.OSRM.idFromName("sri-lanka");
    return env.OSRM.get(id).fetch(request);
  },
};

export class OsrmFallbackContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.starting = undefined;
    this.monitoring = undefined;
    this.snapshotting = undefined;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const profile = url.pathname.match(/^\/route\/v1\/(driving|walking)\//)?.[1];
    if (!profile) return new Response("Not Found", { status: 404 });

    const demo = await this.tryDemo(request);
    if (demo) return demo;
    return this.fetchFallback(request, profile);
  }

  async tryDemo(request) {
    const permitted = await this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get("demoRequestAt") || 0;
      const now = Date.now();
      if (now - previous < 1000) return false;
      await txn.put("demoRequestAt", now);
      return true;
    });
    if (!permitted) return null;

    const sourceUrl = new URL(request.url);
    const target = new URL(sourceUrl.pathname + sourceUrl.search, DEMO_ORIGIN);
    try {
      const response = await fetch(target, {
        headers: {
          Accept: "application/json",
          "User-Agent": "LK-Maps (https://maps.mazo.workers.dev/)",
          Referer: "https://maps.mazo.workers.dev/",
        },
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) return null;
      const result = await response.clone().json();
      return result.code === "Ok" ? response : null;
    } catch {
      return null;
    }
  }

  async fetchFallback(request, profile) {
    this.starting ??= this.startContainer().finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    const port = this.ctx.container.getTcpPort(PROFILE_PORT[profile]);
    let ready = false;
    try {
      const health = await port.fetch(`http://container${HEALTH_PATH[profile]}`, {
        signal: AbortSignal.timeout(2500),
      });
      const result = await health.json();
      ready = health.ok && result.code === "Ok";
    } catch {
      // OSRM may still be preprocessing the Sri Lanka extract.
    }
    if (!ready) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return Response.json(
        { message: "The OSRM fallback is preparing its map data. Retry shortly." },
        { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } },
      );
    }

    this.ctx.waitUntil(this.saveSnapshot());
    const target = new URL(request.url);
    target.protocol = "http:";
    target.host = "container";
    target.pathname = target.pathname.replace(
      /^\/route\/v1\/(?:driving|walking)\//,
      `/route/v1/${profile === "walking" ? "foot" : "car"}/`,
    );
    const forwarded = new Request(target, request);
    forwarded.headers.delete("host");
    return port.fetch(forwarded);
  }

  async alarm() {
    await this.startContainer();
    const healthy = await this.checkProfiles();
    if (healthy) {
      await this.saveSnapshot();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async checkProfiles() {
    for (const profile of Object.keys(PROFILE_PORT)) {
      try {
        const port = this.ctx.container.getTcpPort(PROFILE_PORT[profile]);
        const response = await port.fetch(`http://container${HEALTH_PATH[profile]}`, {
          signal: AbortSignal.timeout(2500),
        });
        const result = await response.json();
        if (!response.ok || result.code !== "Ok") return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async startContainer() {
    const container = this.ctx.container;
    if (!container) throw new Error("OSRM container binding is unavailable.");
    if (!container.running) {
      const saved = await this.ctx.storage.get("osrmSnapshot");
      if (saved?.version === SNAPSHOT_VERSION) {
        try {
          container.start({ containerSnapshot: saved.snapshot, enableInternet: false });
        } catch {
          container.start({ image: container.images.base, instance: INSTANCE_TYPE, enableInternet: true });
        }
      } else {
        container.start({ image: container.images.base, instance: INSTANCE_TYPE, enableInternet: true });
      }
    }
    await container.setInactivityTimeout(IDLE_TIMEOUT_MS);
    if (!this.monitoring) {
      this.monitoring = container.monitor()
        .catch((error) => console.error("OSRM fallback container exited:", error?.message || "unknown error"))
        .finally(() => { this.monitoring = undefined; });
      this.ctx.waitUntil(this.monitoring);
    }
  }

  async saveSnapshot() {
    this.snapshotting ??= (async () => {
      const saved = await this.ctx.storage.get("osrmSnapshot");
      if (saved?.version === SNAPSHOT_VERSION) return;
      try {
        const snapshot = await this.ctx.container.snapshotContainer({ name: SNAPSHOT_VERSION });
        await this.ctx.storage.put("osrmSnapshot", { version: SNAPSHOT_VERSION, snapshot });
      } catch (error) {
        console.error("Could not save OSRM fallback snapshot:", error?.message || "unknown error");
      }
    })().finally(() => { this.snapshotting = undefined; });
    return this.snapshotting;
  }
}
