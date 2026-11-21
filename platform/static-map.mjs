export function createStaticRenderer(origin, executablePath, renderToken) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(renderToken)) throw new Error('Invalid Sifric renderer token.');
  let busy = false;
  const base = new URL(origin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('SIFRIC_WEB_ORIGIN must be an HTTP(S) origin.');
  }
  return async function render({ lon, lat, zoom, width, height, pin }) {
    if (busy) return null;
    busy = true;
    let browser;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({
        executablePath,
        timeout: 10000,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      });
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await page.route('**/*', route => {
        const requested = new URL(route.request().url());
        if (requested.origin !== base.origin) return route.abort();
        if (!requested.pathname.startsWith('/developer/')) return route.continue();
        return route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${renderToken}` } });
      });
      const url = new URL('/developer/embed/', base);
      url.search = new URLSearchParams({ lon, lat, zoom, pin: pin ? '1' : '0' });
      const navigation = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 12000 });
      if (!navigation?.ok()) throw new Error('Sifric embed failed to load.');
      await page.locator('#map[data-ready="true"]').waitFor({ timeout: 20000 });
      return await page.locator('#map').screenshot({ type: 'png', timeout: 8000 });
    } finally {
      try { await browser?.close(); }
      finally { busy = false; }
    }
  };
}
