import { routingRequest, routingProfile, RoutingError } from '../worker/routing.mjs';

export default {
  async fetch(request, env) {
    const operation = new URL(request.url).pathname.slice(1);
    if (request.method !== 'POST' || !['routes', 'matrix', 'match'].includes(operation)) {
      return Response.json({ error: 'Unknown routing operation.' }, { status: 404 });
    }
    try {
      const body = await request.json();
      if (routingProfile(body) !== env.SIFRIC_ROUTING_MODE) {
        return Response.json({ error: 'Routing mode does not match the bound service.' }, { status: 400 });
      }
      return Response.json(await routingRequest(env.TILES_BUCKET, operation, body));
    } catch (error) {
      if (error instanceof RoutingError) return Response.json({ error: error.message }, { status: error.status });
      console.warn('Routing graph request failed', { operation, reason: error?.message?.slice(0, 120) });
      return Response.json({ error: 'Sifric routing is temporarily unavailable.' }, { status: 503 });
    }
  },
};
