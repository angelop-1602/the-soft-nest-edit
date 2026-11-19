import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import localWorker from '../src/local-admin-worker.js';
import { authEnv, jwt, externalMock, adminRequest, actorEmail } from './helpers/admin.mjs';
import { request } from './helpers/d1.mjs';
import { digest } from '../src/commerce-security.js';
import { readFileSync } from 'node:fs';

test('all private page aliases and administrator APIs require a signed Access JWT before D1 access', async () => {
  const env = authEnv();
  env.DB = {
    prepare() {
      throw new Error('Unauthorized DB access');
    }
  };
  for (const path of [
    '/admin/products',
    '/admin/products/',
    '/admin/products/index.html',
    '/admin/products/anything',
    '/api/admin/products',
    '/api/admin/session',
    '/api/admin/policy'
  ]) {
    const res = await worker.fetch(request(path), env);
    assert.equal(res.status, 401, path);
    assert.match(res.headers.get('Cache-Control'), /no-store/);
    assert.match(res.headers.get('X-Robots-Tag'), /noindex/);
  }
  assert.equal(
    (
      await worker.fetch(
        request('/admin/products/', undefined, {
          headers: { 'Cf-Access-Authenticated-User-Email': actorEmail }
        }),
        env
      )
    ).status,
    401
  );
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(config.assets.run_worker_first.includes('/admin/products/*'));
  assert.ok(config.assets.run_worker_first.includes('/admin/products'));
  assert.equal(config.main, 'src/index.js');
  assert.ok(
    !readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').includes(
      'local-admin-worker'
    )
  );
});
test('invalid, expired, future, wrong issuer/audience and non-application JWTs fail closed', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  globalThis.fetch = externalMock();
  const now = Math.floor(Date.now() / 1000);
  try {
    const tokens = [
      'not-a-jwt',
      await jwt({ exp: now - 1 }),
      await jwt({ nbf: now + 60 }),
      await jwt({ iat: now + 60 }),
      await jwt({ iss: 'https://evil.test' }),
      await jwt({ aud: ['wrong-app'] }),
      await jwt({ type: 'org' }),
      await jwt({ email: undefined }),
      await jwt({}, { alg: 'none' }),
      await jwt({}, { alg: 'HS256' }),
      await jwt({ exp: now + 90000 })
    ];
    const good = await jwt();
    const pieces = good.split('.');
    pieces[2] = (pieces[2][0] === 'A' ? 'B' : 'A') + pieces[2].slice(1);
    tokens.push(pieces.join('.'));
    for (const token of tokens)
      assert.equal(
        (
          await worker.fetch(
            request('/admin/products/', undefined, {
              headers: { 'Cf-Access-Jwt-Assertion': token }
            }),
            env
          )
        ).status,
        401
      );
    assert.equal(
      (
        await worker.fetch(
          request('/admin/products/', undefined, {
            headers: { 'Cf-Access-Jwt-Assertion': await jwt({ email: 'stranger@example.test' }) }
          }),
          env
        )
      ).status,
      403
    );
    const res = await worker.fetch(
      request('/admin/products/', undefined, { headers: { 'Cf-Access-Jwt-Assertion': good } }),
      env
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Product Atelier'));
    assert.ok(!html.includes('MOCK-CJ'));
    assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  } finally {
    globalThis.fetch = old;
  }
});
test('unconfigured Access and local test secrets cannot enable production administrator access', async () => {
  const env = authEnv();
  env.LOCAL_ADMIN_SESSION_KEY = 'f'.repeat(64);
  env.LOCAL_ADMIN_LOGIN_HASH = 'd'.repeat(64);
  env.LOCAL_ADMIN_ORIGIN = 'http://localhost:8787';
  assert.equal(
    (
      await worker.fetch(
        request('/admin/products/', undefined, {
          headers: { Cookie: 'softnest-local-admin=anything' }
        }),
        env
      )
    ).status,
    401
  );
  for (const patch of [
    { CF_ACCESS_AUD: '' },
    { CF_ACCESS_TEAM_DOMAIN: 'https://attacker.test' },
    { ADMIN_EMAIL_ALLOWLIST: '[]' }
  ]) {
    assert.equal(
      (
        await worker.fetch(
          request('/admin/products/', undefined, {
            headers: { 'Cf-Access-Jwt-Assertion': await jwt() }
          }),
          { ...env, ...patch }
        )
      ).status,
      401
    );
  }
});
test('administrator mutations reject CSRF, wrong content type and oversized input without writes', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  globalThis.fetch = externalMock();
  try {
    for (const [headers, body, status] of [
      [{ Origin: 'https://evil.test' }, {}, 403],
      [{ 'X-Softnest-Admin': '' }, {}, 403],
      [{ 'Content-Type': 'text/plain' }, {}, 415],
      [{}, { padding: 'x'.repeat(25000) }, 413]
    ]) {
      assert.equal(
        (await worker.fetch(await adminRequest('products/TEST-P1/review', body, { headers }), env))
          .status,
        status
      );
    }
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit').first()).n, 0);
  } finally {
    globalThis.fetch = old;
  }
});
test('local administrator mode requires generated credentials, exact HTTP loopback and a valid signed cookie', async () => {
  const code = crypto.randomUUID() + crypto.randomUUID(),
    source = 'http://127.0.0.1:8799',
    env = authEnv();
  Object.assign(env, {
    LOCAL_ADMIN_ORIGIN: source,
    LOCAL_ADMIN_LOGIN_HASH: await digest(code),
    LOCAL_ADMIN_SESSION_KEY: 'a'.repeat(64)
  });
  for (const remote of [
    'https://thesoftnestedit.online',
    'http://localhost:8799',
    'https://127.0.0.1:8799'
  ])
    assert.equal(
      (await localWorker.fetch(request('/admin/products/', undefined, { source: remote }), env))
        .status,
      403
    );
  assert.equal(
    (await localWorker.fetch(request('/admin/products/', undefined, { source }), env)).status,
    401
  );
  assert.equal(
    (await localWorker.fetch(request('/admin/products/login', { code: 'bad' }, { source }), env))
      .status,
    401
  );
  assert.equal(
    (
      await localWorker.fetch(
        request(
          '/admin/products/login',
          { code },
          { source, headers: { Origin: 'https://evil.test' } }
        ),
        env
      )
    ).status,
    403
  );
  const login = await localWorker.fetch(
    request('/admin/products/login', { code }, { source }),
    env
  );
  assert.equal(login.status, 200);
  const cookie = login.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal(
    (
      await localWorker.fetch(
        request('/admin/products/', undefined, { source, cookieValue: cookie.split(';')[0] }),
        env
      )
    ).status,
    200
  );
  assert.equal(
    (
      await localWorker.fetch(
        request('/admin/products/', undefined, { source, cookieValue: cookie.split(';')[0] + 'x' }),
        env
      )
    ).status,
    401
  );
  // The very same valid local session is rejected by the production entry.
  assert.equal(
    (
      await worker.fetch(
        request('/admin/products/', undefined, { source, cookieValue: cookie.split(';')[0] }),
        env
      )
    ).status,
    401
  );
});
