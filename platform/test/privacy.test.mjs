import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createPrivateGateway } from '../../worker/private-gateway.mjs';

const token = randomBytes(32).toString('base64url');
const backend = randomBytes(32).toString('base64url');
const env = {
  SIFRIC_DEVELOPER_TOKEN_HASHES: JSON.stringify([createHash('sha256').update(token).digest('hex')]),
  SIFRIC_PLATFORM_ORIGIN: 'https://private.example',
  SIFRIC_PLATFORM_TOKEN: backend,
};
const gateway = createPrivateGateway(new Map([['/developer/', ['example portal', 'text/html']]]));
const req = (path, options = {}) => new Request('https://maps.sifric.workers.dev' + path, options);

test('developer routes fail closed and do not call origin for unauthenticated requests', async () => {
  const call = () => assert.fail('An unauthenticated request reached the origin');
  const path = '/developer/api/v1/health';
  for (const [configuration, header, status] of [
    [{}, null, 404], [env, null, 401], [env, 'Bearer ' + backend, 401],
    [{ ...env, SIFRIC_DEVELOPER_TOKEN_HASHES: 'invalid' }, 'Bearer ' + token, 401],
  ]) {
    const headers = header ? { Authorization: header } : {};
    const response = await gateway(req(path, { headers }), configuration, path, call);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
  }
});

test('same-host Basic opens the private portal and bearer credentials are replaced at the API boundary', async () => {
  const header = 'Basic ' + Buffer.from('sifric:' + token).toString('base64');
  const portal = '/developer/';
  assert.equal(await (await gateway(req(portal, { headers: { Authorization: header } }), env, portal)).text(), 'example portal');
  const path = '/developer/api/v1/places/search';
  const browser = req(path + '?q=Colombo', { headers: { Authorization: 'Bearer ' + token, Cookie: 'ignore=me' } });
  const result = await gateway(browser, env, path, (endpoint, init) => {
    assert.equal(endpoint.href, 'https://private.example/api/v1/places/search?q=Colombo');
    assert.deepEqual(init.headers, { Authorization: 'Bearer ' + backend });
    assert.equal(init.redirect, 'error');
    return Response.json({ items: [] }, { headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await result.json(), { items: [] });
  const crossSite = req(portal, { headers: { Authorization: header, Origin: 'https://elsewhere.example' } });
  assert.equal((await gateway(crossSite, env, portal)).status, 403);
});

test('external links may open authenticated HTML documents but cannot embed or call private APIs', async () => {
  const portal = '/developer/';
  const crossSite = {
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
  };
  const headers = { ...crossSite, Authorization: 'Bearer ' + token };
  assert.equal((await gateway(req(portal, { headers: crossSite }), env, portal)).status, 401);
  const page = await gateway(req(portal, { headers }), env, portal);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal((await gateway(req(portal, {
    headers: { ...headers, 'Sec-Fetch-Dest': 'iframe' },
  }), env, portal)).status, 403);
  assert.equal((await gateway(req(portal, {
    method: 'POST', headers,
  }), env, portal)).status, 403);
  const path = '/developer/api/v1/health';
  assert.equal((await gateway(req(path, { headers }), env, path, () => {
    assert.fail('Cross-site navigation reached the API.');
  })).status, 403);
});
