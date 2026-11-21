import puppeteer from '@cloudflare/puppeteer';

const embedAssets = new Set([
  '/developer/embed/', '/developer/embed.js', '/developer/embed.css', '/developer/sifric-maps.js',
]);

export async function renderStaticMap(binding, request, options) {
  const { width, height, lon, lat, zoom, pin, theme } = options;
  const { origin } = new URL(request.url);
  const url = new URL('/developer/embed/', origin);
  url.search = new URLSearchParams({ lon, lat, zoom, pin, theme, static: '1' });
  const authorization = request.headers.get('Authorization');
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(12000);
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', intercepted => {
      const target = new URL(intercepted.url());
      if (target.origin !== origin) return intercepted.abort();
      if (embedAssets.has(target.pathname)) {
        return intercepted.continue({ headers: { ...intercepted.headers(), authorization } });
      }
      return intercepted.continue();
    });
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    if (!response?.ok()) throw new Error('Embed unavailable.');
    await page.waitForSelector('#map[data-ready="true"], #status:not([hidden])');
    if (!(await page.$('#map[data-ready="true"]'))) throw new Error('Map unavailable.');
    return await page.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}
