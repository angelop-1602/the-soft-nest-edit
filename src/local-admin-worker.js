/** DEVELOPMENT ENTRY ONLY. Production wrangler.jsonc never imports this module.
 * Requires a generated per-run secret, an exact HTTP loopback origin and a signed session.
 * No env flag in the production Worker can enable this authentication method.
 */
import worker from './index.js';
import { isAdminPath, handleAdmin, adminError } from './admin-products-api.js';
import { ADMIN_HEADERS, adminReply, parseJwt, checkClaims } from './admin-auth.js';
import { CommerceError, readJson, digest } from './commerce-security.js';

const ISSUER = 'softnest-local-admin',
  AUD = 'softnest-products-local';
const encoder = new TextEncoder();
const b64 = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
async function key(env) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.LOCAL_ADMIN_SESSION_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}
function allowed(request, env) {
  const url = new URL(request.url);
  return (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.origin === env.LOCAL_ADMIN_ORIGIN &&
    /^[0-9a-f]{64}$/.test(env.LOCAL_ADMIN_SESSION_KEY || '') &&
    /^[0-9a-f]{64}$/.test(env.LOCAL_ADMIN_LOGIN_HASH || '')
  );
}
export async function authenticateLocalAdmin(request, env) {
  if (!allowed(request, env))
    throw new CommerceError(
      'local_only',
      'Local administrator testing requires the generated loopback development configuration.',
      403
    );
  const raw = (request.headers.get('Cookie') || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('softnest-local-admin='))
    ?.slice('softnest-local-admin='.length);
  const jwt = parseJwt(raw);
  if (jwt.header.alg !== 'HS256' || jwt.header.typ !== 'JWT')
    throw new CommerceError('admin_unauthorized', 'Local administrator sign-in is required.', 401);
  checkClaims(jwt.claims, ISSUER, AUD);
  if (!(await crypto.subtle.verify('HMAC', await key(env), jwt.signature, jwt.signed)))
    throw new CommerceError('admin_unauthorized', 'Local administrator sign-in is required.', 401);
  return {
    sub: 'local-administrator',
    email: 'local-admin@example.test',
    source: 'local_development'
  };
}
const loginPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Local administrator sign-in | The Soft Nest Edit</title><link rel="stylesheet" href="/assets/admin-products.css"><script src="/assets/admin-local-login.js" defer></script></head><body><main class="login-card"><p class="eyebrow">THE SOFT NEST EDIT / LOCAL DEVELOPMENT</p><h1>Your private<br><em>workspace.</em></h1><p>Copy the temporary sign-in code from <code>.local/admin/login-code.txt</code>. It changes every time you start development with <code>--admin</code>.</p><form id="local-admin-login"><label for="local-code">Temporary local code</label><input id="local-code" type="password" autocomplete="off" required maxlength="100"><button class="button" type="submit">Open product atelier</button></form><p id="login-message" role="status" aria-live="polite"></p><p class="small">This method works only in the dedicated local Worker. Production requires Cloudflare Access.</p></main></body></html>`;
export default {
  async fetch(request, env) {
    if (!allowed(request, env))
      return adminReply(
        { error: 'This development entry cannot serve non-loopback requests.' },
        403
      );
    const url = new URL(request.url);
    if (url.pathname === '/admin/products/login' && request.method === 'GET')
      return new Response(loginPage, {
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'text/html; charset=utf-8' }
      });
    if (url.pathname === '/admin/products/login' && request.method === 'POST') {
      try {
        const payload = await readJson(request, 500);
        if (typeof payload?.code !== 'string' || payload.code.length > 100)
          throw new CommerceError('admin_unauthorized', 'Invalid local sign-in code.', 401);
        const hash = await digest(payload.code);
        let difference = 0;
        for (let i = 0; i < 64; i++)
          difference |= hash.charCodeAt(i) ^ env.LOCAL_ADMIN_LOGIN_HASH.charCodeAt(i);
        if (difference)
          throw new CommerceError('admin_unauthorized', 'Invalid local sign-in code.', 401);
        const now = Math.floor(Date.now() / 1000),
          header = b64(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
        const claims = b64(
          encoder.encode(
            JSON.stringify({
              iss: ISSUER,
              aud: AUD,
              sub: 'local-administrator',
              iat: now,
              exp: now + 3600
            })
          )
        );
        const signed = header + '.' + claims;
        const signature = b64(
          new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), encoder.encode(signed)))
        );
        return Response.json(
          { ok: true },
          {
            headers: {
              ...ADMIN_HEADERS,
              'Set-Cookie': `softnest-local-admin=${signed}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`
            }
          }
        );
      } catch (error) {
        return adminError(error);
      }
    }
    if (url.pathname === '/admin/products/logout' && request.method === 'POST') {
      try {
        await readJson(request, 100);
        return Response.json(
          { ok: true },
          {
            headers: {
              ...ADMIN_HEADERS,
              'Set-Cookie': 'softnest-local-admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
            }
          }
        );
      } catch (error) {
        return adminError(error);
      }
    }
    if (isAdminPath(url.pathname)) {
      try {
        return await handleAdmin(request, env, await authenticateLocalAdmin(request, env));
      } catch (error) {
        return adminError(error);
      }
    }
    return worker.fetch(request, env);
  }
};
