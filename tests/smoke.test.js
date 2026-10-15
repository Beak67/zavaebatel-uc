import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

process.env.NEXUS_PRICE_CURRENCY = 'USD';
process.env.NEXUS_USD_RUB = '85';
process.env.SALE_MARKUP = '0.20';
const { default: app, normalizeProducts, retailPrice, getCatalog } = await import('../server.js');
process.env.NEXUS_SHOP_ID = 'test-shop';
process.env.NEXUS_SHOP_TOKEN = 'test-token';

test('normalizes UC products and excludes unrelated product IDs', () => {
  assert.deepEqual(normalizeProducts({ products: [
    { id: 'pubg-mobile:uc:60', name: '60 UC', price: '1.2' },
    { id: 'other:thing', price: 3 }
  ] }), [{ id: 'pubg-mobile:uc:60', name: '60 UC', icon: null, priceUsd: 1.2 }]);
});
test('rejects unrecognized supplier response', () => assert.throws(() => normalizeProducts({ unexpected: true }), /списка товаров/));
test('rejects zero, negative, and non-numeric supplier prices', () => {
  for (const price of [0, -1, 'not-a-price', '', Infinity]) {
    assert.throws(() => normalizeProducts([{ id: 'pubg-mobile:uc:60', price }]), /price|цен/);
  }
});
test('retail price is USD price × 85 × 1.20, rounded to kopecks', () => {
  assert.equal(retailPrice(1.23), 125.46);
  assert.equal(retailPrice(1.25), 127.5);
});
test('missing currency is rejected in a clean process', () => {
  const code = "import('./server.js').then(m => { try { m.retailPrice(1); process.exit(2); } catch (e) { if (!e.message.includes('NEXUS_PRICE_CURRENCY')) process.exit(3); } })";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(), env: { ...process.env, NEXUS_PRICE_CURRENCY: '' }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});
test('fetches and normalizes a successful Nexus response', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ products: [{ id: 'pubg-mobile:uc:60', name: '60 UC', price: 1.25 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try { assert.deepEqual(await getCatalog(), [{ id: 'pubg-mobile:uc:60', name: '60 UC', icon: null, priceUsd: 1.25 }]); }
  finally { globalThis.fetch = original; }
});
test('rejects malformed Nexus JSON without exposing authorization data', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('not-json', { status: 200 });
  try { await assert.rejects(getCatalog(), /некорректный JSON/); }
  finally { globalThis.fetch = original; }
});
test('bounds retries after temporary Nexus timeout', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Object.assign(new Error('network'), { name: 'TimeoutError' }); };
  try { await assert.rejects(getCatalog(), /временно недоступен/); assert.equal(calls, 2); }
  finally { globalThis.fetch = original; }
});
test('does not retry non-transient Nexus HTTP errors indefinitely', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('denied', { status: 401 }); };
  try { await assert.rejects(getCatalog(), /HTTP 401/); assert.equal(calls, 1); }
  finally { globalThis.fetch = original; }
});
test('handles a network-level Nexus outage with bounded retries', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('network unavailable'); };
  try {
    await assert.rejects(getCatalog(), /Nexus временно недоступен/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
test('public assets contain no configured test credentials', async () => {
  for (const file of ['public/index.html', 'public/storefront.js', 'public/admin.js', 'public/logo.svg', 'admin.html']) {
    const content = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /test-token|test-shop|SESSION_SECRET=|NEXUS_SHOP_TOKEN=/, file);
  }
});

test('Render routes, public assets, missing files and disabled sales', async () => {
  const originalFetch = globalThis.fetch;
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  // Stub only outbound supplier calls; keep requests to the local test server real.
  globalThis.fetch = async (input, init) => String(input).startsWith(url)
    ? originalFetch(input, init)
    : new Response('denied', { status: 401 });
  try {
    const home = await fetch(url + '/');
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /ZAVAEBATEL UC/);
    assert.match(html, /src="\/storefront\.js"/);
    assert.match(home.headers.get('content-security-policy') || '', /script-src 'self'/);
    const scriptDirective = (home.headers.get('content-security-policy') || '').split(';').find(part => part.trim().startsWith('script-src ')) || '';
    assert.doesNotMatch(scriptDirective, /unsafe-inline/);
    assert.equal((await fetch(url + '/logo.svg')).status, 200);
    assert.equal((await fetch(url + '/storefront.js')).status, 200);
    assert.equal((await fetch(url + '/admin.js')).status, 200);
    assert.equal((await fetch(url + '/admin')).status, 200);
    assert.equal((await fetch(url + '/definitely-missing-static-file.js')).status, 404);
    const health = await fetch(url + '/api/health');
    assert.equal(health.status, 503, 'an unconfigured database must not be reported healthy');
    assert.match(health.headers.get('content-type'), /application\/json/);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, false);
    assert.equal(healthBody.database, 'not_configured');
    assert.equal(healthBody.ordersEnabled, false);
    assert.doesNotMatch(JSON.stringify(healthBody), /test-token|test-shop|Authorization/i);
    const catalog = await fetch(url + '/api/catalog');
    assert.ok([502, 503].includes(catalog.status));
    const catalogBody = await catalog.json();
    assert.equal(typeof catalogBody.error, 'string');
    assert.doesNotMatch(JSON.stringify(catalogBody), /test-token|test-shop|Authorization/i);
    for (const p of ['/server.js', '/package.json', '/.env', '/README.md', '/admin.html']) assert.equal((await fetch(url + p)).status, 404, p);
    const orders = await fetch(url + '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId: 'pubg-mobile:uc:60', playerId: '12345' }) });
    assert.equal(orders.status, 503);
    const receipt = await fetch(url + '/api/orders/00000000-0000-4000-8000-000000000000/receipt', { method: 'POST' });
    assert.equal(receipt.status, 503);
    const adminOrders = await fetch(url + '/api/admin/orders');
    assert.equal(adminOrders.status, 503, 'database is absent in this isolated smoke test; protected data must not be returned');
    const payment = await fetch(url + '/api/payment-info');
    const paymentBody = await payment.json();
    assert.equal(paymentBody.enabled, false);
    assert.match(paymentBody.message, /отключены/);
    const unknownApi = await fetch(url + '/api/this-route-does-not-exist');
    assert.equal(unknownApi.status, 404);
    assert.match(unknownApi.headers.get('content-type') || '', /application\/json/);
    assert.doesNotMatch(await unknownApi.text(), /test-token|test-shop/);
    const unknownPage = await fetch(url + '/this-page-does-not-exist');
    assert.equal(unknownPage.status, 404);

  } finally {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
  }
});
