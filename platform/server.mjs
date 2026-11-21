import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { handleApi } from './api.mjs';
import { createStaticRenderer } from './static-map.mjs';
import { openTiles } from './tiles.mjs';
import { openPlaces } from './places.mjs';

const token = process.env.SIFRIC_PLATFORM_TOKEN ?? '';
if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
  throw new Error('Configure a private SIFRIC_PLATFORM_TOKEN before starting the API.');
}
const expectedAuth = Buffer.from(`Bearer ${token}`);
const places = await openPlaces(process.env.SIFRIC_PLACE_INDEX);
const { SIFRIC_WEB_ORIGIN, SIFRIC_CHROMIUM, SIFRIC_RENDER_TOKEN } = process.env;
const staticRenderer = SIFRIC_WEB_ORIGIN && SIFRIC_CHROMIUM
  ? createStaticRenderer(SIFRIC_WEB_ORIGIN, SIFRIC_CHROMIUM, SIFRIC_RENDER_TOKEN)
  : undefined;
const tiles = process.env.SIFRIC_PMTILES_PATH ? await openTiles(process.env.SIFRIC_PMTILES_PATH) : undefined;
const port = Number(process.env.PORT ?? 8788);
const host = process.env.HOST ?? '127.0.0.1';
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, 'http://localhost');
    const presented = Buffer.from(incoming.headers.authorization ?? '');
    if (presented.length !== expectedAuth.length || !timingSafeEqual(expectedAuth, presented)) {
      outgoing.writeHead(404, { 'Cache-Control': 'private, no-store' }).end();
      return;
    }
    if (!url.pathname.startsWith('/api/v1/')) {
      outgoing.writeHead(404).end();
      return;
    }
    const method = incoming.method;
    const body = method === 'POST' ? Readable.toWeb(incoming) : undefined;
    const request = new Request(url, { method, body, headers: incoming.headers, duplex: 'half' });
    const response = await handleApi(request, places, process.env, staticRenderer, tiles);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
    else outgoing.end();
  } catch {
    if (outgoing.headersSent) outgoing.destroy();
    else outgoing.writeHead(400).end();
  }
});
server.listen(port, host, () => console.log(`Sifric platform API on http://${host}:${port}`));
server.on('close', () => {
  places.close();
  tiles?.close().catch(error => console.error('Could not close tile archive:', error.message));
});
