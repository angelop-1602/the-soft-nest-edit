import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { authEnv, jwt, externalMock, team, aud, actorEmail } from './helpers/admin.mjs';
import { request } from './helpers/d1.mjs';

const denied = { error: 'Administrator sign-in is required.', code: 'admin_unauthorized' };
const path = '/api/admin/session';

test('configuration diagnostics distinguish missing and invalid settings without exposing values', async (t) => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  const env = { ...authEnv(), ADMIN_AUTH_DIAGNOSTICS_ENABLED: 'true' };
  // Configuration must be checked before token processing or any private database action.
  env.DB = {
    prepare() {
      throw new Error('Unexpected DB access');
    }
  };
  for (const [patch, reason] of [
    [{ CF_ACCESS_TEAM_DOMAIN: undefined }, 'CONFIG_TEAM_DOMAIN_MISSING'],
    [{ CF_ACCESS_TEAM_DOMAIN: 'https://private-value.invalid' }, 'CONFIG_TEAM_DOMAIN_INVALID'],
    [
      { CF_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com/incorrect/path' },
      'CONFIG_TEAM_DOMAIN_INVALID'
    ],
    [{ CF_ACCESS_TEAM_DOMAIN: 42 }, 'CONFIG_TEAM_DOMAIN_INVALID'],
    [{ CF_ACCESS_AUD: '' }, 'CONFIG_AUDIENCE_MISSING'],
    [{ CF_ACCESS_AUD: 'private bad audience' }, 'CONFIG_AUDIENCE_INVALID'],
    [{ ADMIN_EMAIL_ALLOWLIST: undefined }, 'CONFIG_ALLOWLIST_MISSING'],
    [{ ADMIN_EMAIL_ALLOWLIST: 'private invalid JSON' }, 'CONFIG_ALLOWLIST_INVALID'],
    [{ ADMIN_EMAIL_ALLOWLIST: '[]' }, 'CONFIG_ALLOWLIST_INVALID'],
    [{ ADMIN_EMAIL_ALLOWLIST: JSON.stringify(['private bad address']) }, 'CONFIG_ALLOWLIST_INVALID']
  ]) {
    logs.length = 0;
    const res = await worker.fetch(request(path), { ...env, ...patch });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), denied);
    assert.deepEqual(logs, [['ADMIN_AUTH_' + reason]]);
  }
});

test('JWT diagnostics distinguish missing headers, mismatches, expiry, claims and signature rejection', async (t) => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', externalMock());
  const env = { ...authEnv(), ADMIN_AUTH_DIAGNOSTICS_ENABLED: 'true' };
  env.DB = {
    prepare() {
      throw new Error('Unexpected DB access');
    }
  };
  const now = Math.floor(Date.now() / 1000);
  const good = await jwt();
  const pieces = good.split('.');
  pieces[2] = (pieces[2][0] === 'A' ? 'B' : 'A') + pieces[2].slice(1);
  for (const [token, reason] of [
    [undefined, 'JWT_HEADER_MISSING'],
    ['malformed-private-token', 'JWT_MALFORMED'],
    [await jwt({}, { alg: 'HS256' }), 'JWT_HEADER_INVALID'],
    [await jwt({ iss: 'https://private-issuer.invalid' }), 'JWT_ISSUER_MISMATCH'],
    [await jwt({ aud: ['private-wrong-audience'] }), 'JWT_AUDIENCE_MISMATCH'],
    [await jwt({ exp: now - 1 }), 'JWT_EXPIRED'],
    [await jwt({ exp: String(now + 60) }), 'JWT_CLAIMS_INVALID'],
    [await jwt({ nbf: now + 300 }), 'JWT_CLAIMS_INVALID'],
    [await jwt({ iat: now + 300 }), 'JWT_CLAIMS_INVALID'],
    [await jwt({ exp: now + 90000 }), 'JWT_CLAIMS_INVALID'],
    [await jwt({ sub: '' }), 'JWT_CLAIMS_INVALID'],
    [await jwt({ type: 'org' }), 'JWT_CLAIMS_INVALID'],
    [await jwt({ type: undefined }), 'JWT_CLAIMS_INVALID'],
    [await jwt({ email: undefined }), 'JWT_CLAIMS_INVALID'],
    [pieces.join('.'), 'JWT_SIGNATURE_INVALID'],
    [await jwt({ email: 'unlisted-private-identity@example.test' }), 'IDENTITY_NOT_ALLOWED']
  ]) {
    logs.length = 0;
    const res = await worker.fetch(
      request(path, undefined, {
        headers: {
          ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}),
          Cookie: 'CF_Authorization=private-cookie-value',
          'Cf-Access-Authenticated-User-Email': actorEmail
        }
      }),
      env
    );
    assert.equal(res.status, reason === 'IDENTITY_NOT_ALLOWED' ? 403 : 401, reason);
    if (res.status === 401) assert.deepEqual(await res.json(), denied);
    else
      assert.deepEqual(await res.json(), {
        error: 'This identity is not authorized for product administration.',
        code: 'admin_forbidden'
      });
    assert.match(res.headers.get('Cache-Control'), /no-store/);
    assert.deepEqual(logs, [['ADMIN_AUTH_' + reason]]);
  }
});

test('public signing-key failures stay distinct from a bad JWT signature and expose no upstream errors', async (t) => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  let respond;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(
      url,
      /^https:\/\/diagnostic-keys-\d+\.cloudflareaccess\.com\/cdn-cgi\/access\/certs$/
    );
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return respond();
  });
  let n = 0;
  for (const [response, reason] of [
    [
      () => {
        throw new Error('private upstream credentials and response');
      },
      'SIGNING_KEYS_FETCH_FAILED'
    ],
    [
      () => {
        throw new DOMException('private timeout details', 'TimeoutError');
      },
      'SIGNING_KEYS_FETCH_FAILED'
    ],
    [() => new Response('private upstream body', { status: 503 }), 'SIGNING_KEYS_FETCH_FAILED'],
    [() => new Response('private invalid JSON'), 'SIGNING_KEYS_INVALID'],
    [() => Response.json({ keys: 'private malformed data' }), 'SIGNING_KEYS_INVALID'],
    [() => Response.json({ keys: [null] }), 'SIGNING_KEYS_INVALID'],
    [() => Response.json({ keys: [] }), 'SIGNING_KEY_NOT_FOUND'],
    [
      () =>
        Response.json({ keys: [{ kid: 'softnest-test-key', kty: 'RSA', n: 'bad', e: 'AQAB' }] }),
      'SIGNING_KEY_INVALID'
    ]
  ]) {
    respond = response;
    const issuer = `https://diagnostic-keys-${++n}.cloudflareaccess.com`;
    const env = {
      ...authEnv(),
      CF_ACCESS_TEAM_DOMAIN: issuer,
      ADMIN_AUTH_DIAGNOSTICS_ENABLED: 'true'
    };
    logs.length = 0;
    const res = await worker.fetch(
      request(path, undefined, {
        headers: { 'Cf-Access-Jwt-Assertion': await jwt({ iss: issuer }) }
      }),
      env
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), denied);
    assert.deepEqual(logs, [['ADMIN_AUTH_' + reason]]);
  }
});

test('Web Crypto key import and signature exceptions have separate safe diagnostics', async (t) => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', externalMock());
  const token = await jwt();
  const env = { ...authEnv(), ADMIN_AUTH_DIAGNOSTICS_ENABLED: 'true' };
  for (const [operation, reason] of [
    ['importKey', 'SIGNING_KEY_INVALID'],
    ['verify', 'JWT_SIGNATURE_INVALID']
  ]) {
    logs.length = 0;
    const mocked = t.mock.method(crypto.subtle, operation, async () => {
      throw new Error('Private cryptographic error details');
    });
    const res = await worker.fetch(
      request(path, undefined, {
        headers: { 'Cf-Access-Jwt-Assertion': token }
      }),
      env
    );
    mocked.mock.restore();
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), denied);
    assert.deepEqual(logs, [['ADMIN_AUTH_' + reason]]);
  }
});

test('diagnostics are opt-in through server configuration only and silent on success', async (t) => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', externalMock());
  for (const flag of [undefined, 'false', true, 'TRUE', '1']) {
    const res = await worker.fetch(
      request(path + '?ADMIN_AUTH_DIAGNOSTICS_ENABLED=true', undefined, {
        headers: { ADMIN_AUTH_DIAGNOSTICS_ENABLED: 'true' }
      }),
      { ...authEnv(), ADMIN_AUTH_DIAGNOSTICS_ENABLED: flag }
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), denied);
    assert.deepEqual(logs, []);
  }
  const env = { ...authEnv(), ADMIN_AUTH_DIAGNOSTICS_ENABLED: 'true' };
  const token = await jwt({ nbf: Math.floor(Date.now() / 1000), aud: [aud, 'another-app'] });
  for (const url of ['/admin/products/', path]) {
    const res = await worker.fetch(
      request(url, undefined, {
        headers: { 'Cf-Access-Jwt-Assertion': token }
      }),
      env
    );
    assert.equal(res.status, 200);
    assert.ok(!(await res.text()).includes('ADMIN_AUTH_'));
  }
  assert.deepEqual(logs, []);
});

test('a logging failure cannot change the denied authentication result', async (t) => {
  t.mock.method(console, 'warn', () => {
    throw new Error('Logger unavailable');
  });
  const res = await worker.fetch(request(path), {
    ...authEnv(),
    ADMIN_AUTH_DIAGNOSTICS_ENABLED: 'true'
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), denied);
});

test('signing keys remain cached and a transient retrieval failure can be retried safely', async (t) => {
  const issuer = 'https://diagnostic-key-retry.cloudflareaccess.com';
  const env = {
    ...authEnv(),
    CF_ACCESS_TEAM_DOMAIN: issuer,
    ADMIN_AUTH_DIAGNOSTICS_ENABLED: 'true'
  };
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) throw new Error('Network unavailable');
    return externalMock()(team + '/cdn-cgi/access/certs');
  });
  const token = await jwt({ iss: issuer });
  const authenticated = () =>
    request('/admin/products/', undefined, {
      headers: { 'Cf-Access-Jwt-Assertion': token }
    });
  assert.equal((await worker.fetch(authenticated(), env)).status, 401);
  assert.equal((await worker.fetch(authenticated(), env)).status, 200);
  assert.equal((await worker.fetch(authenticated(), env)).status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(logs, [['ADMIN_AUTH_SIGNING_KEYS_FETCH_FAILED']]);
});
