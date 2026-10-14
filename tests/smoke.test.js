import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

process.env.NEXUS_PRICE_CURRENCY = 'USD';
process.env.NEXUS_USD_RUB = '85';
process.env.SALE_MARKUP = '0.20';
const { default: app, normalizeProducts, retailPrice } = await import('../server.js');

test('normalizes a known list envelope and filters non-UC products', () => {
  assert.deepEqual(normalizeProducts({ products: [
    { id: 'pubg-mobile:uc:60', name: '60 UC', price: '1.2' },
    { id: 'other:thing', price: 3 }
  ] }), [{ id: 'pubg-mobile:uc:60', name: '60 UC', icon: null, priceUsd: 1.2 }]);
});
test('rejects unrecognized supplier body', () => assert.throws(() => normalizeProducts({ unexpected: true }), /списка товаров/));
test('retail price uses USD FX and markup', () => assert.equal(retailPrice(1.23), 125.46));
test('missing currency is rejected in a clean process', () => {
  const code = "import('./server.js').then(m => { try { m.retailPrice(1); process.exit(2); } catch (e) { if (!e.message.includes('NEXUS_PRICE_CURRENCY')) process.exit(3); } })";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(), env: { ...process.env, NEXUS_PRICE_CURRENCY: '' }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});
test('home, health, catalog errors and internal-file protection', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    const home = await fetch(url + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /ZAVAEBATEL UC/);
    const health = await fetch(url + '/api/health');
    assert.match(health.headers.get('content-type'), /application\\/json/);
    const catalog = await fetch(url + '/api/catalog');
    assert.ok([502, 503].includes(catalog.status));
    assert.equal(typeof (await catalog.json()).error, 'string');
    for (const p of ['/server.js', '/package.json', '/.env', '/README.md', '/admin.html']) assert.equal((await fetch(url + p)).status, 404, p);
    const orders = await fetch(url + '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId: 'pubg-mobile:uc:60', playerId: '12345' }) });
    assert.ok([429, 503].includes(orders.status));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
