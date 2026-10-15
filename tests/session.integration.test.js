import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';

const SECRET = 'ci-only-session-secret-not-production-0123456789';
const ADMIN_PASSWORD = 'ci-only-admin-password-never-production';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function startApp({ databaseUrl, autoInit = 'false' }) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      DB_AUTO_INIT: autoInit,
      SESSION_SECRET: SECRET,
      ADMIN_PASSWORD,
      TRUST_PROXY_HOPS: '1',
      NEXUS_SHOP_ID: '',
      NEXUS_SHOP_TOKEN: '',
      SBP_ENABLED: 'false'
    },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(base + '/api/payment-info');
      if (r.status === 200) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) {
    child.kill('SIGTERM');
    throw new Error('Test server did not start; no environment values were logged.');
  }
  return { child, base, stop: () => child.kill('SIGTERM') };
}
function signedSessionCookie(sid = 'session-store-outage-check') {
  const signature = createHmac('sha256', SECRET).update(sid).digest('base64').replace(/=+$/, '');
  return `zuc.sid=s%3A${sid}.${signature}`;
}

test('PostgreSQL-backed admin sessions, login, CSRF, logout, and safe-mode admin actions', { skip: !TEST_DATABASE_URL ? 'TEST_DATABASE_URL is not configured; CI runs this test with a real PostgreSQL service.' : false }, async () => {
  const app = await startApp({ databaseUrl: TEST_DATABASE_URL, autoInit: 'true' });
  try {
    const unauth = await fetch(app.base + '/api/admin/orders');
    assert.equal(unauth.status, 401);

    const wrongOrigin = await fetch(app.base + '/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid' },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    assert.equal(wrongOrigin.status, 403);

    const badLogin = await fetch(app.base + '/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: app.base },
      body: JSON.stringify({ password: 'incorrect-password' })
    });
    assert.equal(badLogin.status, 401);

    const login = await fetch(app.base + '/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: app.base },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie') || '';
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(';', 1)[0];
    assert.match(cookie, /^zuc\.sid=/);
    const loginBody = await login.json();
    assert.equal(typeof loginBody.csrfToken, 'string');
    assert.ok(loginBody.csrfToken.length >= 32);

    const session = await fetch(app.base + '/api/admin/session', { headers: { cookie } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).csrfToken, loginBody.csrfToken);

    const orders = await fetch(app.base + '/api/admin/orders', { headers: { cookie } });
    assert.equal(orders.status, 200);

    const noCsrfLogout = await fetch(app.base + '/api/admin/logout', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(noCsrfLogout.status, 403);

    const badCsrfLogout = await fetch(app.base + '/api/admin/logout', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': 'wrong-token' }, body: '{}'
    });
    assert.equal(badCsrfLogout.status, 403);

    const disabledAction = await fetch(app.base + '/api/admin/orders/00000000-0000-4000-8000-000000000000/fulfill', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': loginBody.csrfToken },
      body: '{}'
    });
    assert.equal(disabledAction.status, 503, 'fulfillment must remain disabled even for an authenticated administrator');

    const logout = await fetch(app.base + '/api/admin/logout', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': loginBody.csrfToken }, body: '{}'
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/i);
    const afterLogout = await fetch(app.base + '/api/admin/session', { headers: { cookie } });
    assert.equal(afterLogout.status, 401);

    const health = await fetch(app.base + '/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ordersEnabled, false);
  } finally {
    app.stop();
  }
});

test('unavailable PostgreSQL session storage fails closed and never falls back to MemoryStore', async () => {
  const app = await startApp({ databaseUrl: 'postgres://postgres:postgres@127.0.0.1:1/zavaebatel_test', autoInit: 'false' });
  try {
    const health = await fetch(app.base + '/api/health');
    assert.equal(health.status, 503);

    const login = await fetch(app.base + '/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: app.base },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    assert.equal(login.status, 503);
    assert.equal(login.headers.get('set-cookie'), null);

    const sessionLookup = await fetch(app.base + '/api/admin/session', { headers: { cookie: signedSessionCookie() } });
    assert.equal(sessionLookup.status, 503);
    const body = await sessionLookup.json();
    assert.match(body.error, /недоступны/i);
    assert.doesNotMatch(JSON.stringify(body), /postgres:postgres|SESSION_SECRET|ADMIN_PASSWORD/i);
  } finally {
    app.stop();
  }
});
