/** Cloudflare Access application JWT validation using Workers Web Crypto.
 * No development flags, email-header trust, cookie-only Access trust or client claims.
 */
import { CommerceError } from './commerce-security.js';

export const ADMIN_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};
export const adminReply = (value, status = 200) =>
  Response.json(value, { status, headers: ADMIN_HEADERS });
// Temporary diagnostics stay outside Error properties and public API serialization.
const failureReasons = new WeakMap();
const unauthorized = (reason = 'JWT_MALFORMED') => {
  const error = new CommerceError('admin_unauthorized', 'Administrator sign-in is required.', 401);
  failureReasons.set(error, reason);
  return error;
};
export function decodePart(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw unauthorized();
  try {
    return Uint8Array.from(
      atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)),
      (c) => c.charCodeAt(0)
    );
  } catch {
    throw unauthorized();
  }
}
export function parseJwt(token) {
  if (typeof token !== 'string' || token.length > 16384) throw unauthorized();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0].length > 2048) throw unauthorized();
  try {
    const header = JSON.parse(new TextDecoder().decode(decodePart(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decodePart(parts[1])));
    if (!header || !claims || Array.isArray(header) || Array.isArray(claims)) throw unauthorized();
    return {
      header,
      claims,
      signature: decodePart(parts[2]),
      signed: new TextEncoder().encode(parts[0] + '.' + parts[1])
    };
  } catch {
    throw unauthorized();
  }
}
export function checkClaims(claims, issuer, audience, now = Math.floor(Date.now() / 1000)) {
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer) throw unauthorized('JWT_ISSUER_MISMATCH');
  if (!aud.includes(audience)) throw unauthorized('JWT_AUDIENCE_MISMATCH');
  if (!Number.isInteger(claims.exp)) throw unauthorized('JWT_CLAIMS_INVALID');
  if (claims.exp <= now) throw unauthorized('JWT_EXPIRED');
  if (
    !Number.isInteger(claims.iat) ||
    claims.iat > now + 30 ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 86400 ||
    (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now)) ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    claims.sub.length > 200
  )
    throw unauthorized('JWT_CLAIMS_INVALID');
}
const jwksCache = new Map();
async function signingKey(issuer, kid) {
  const now = Date.now();
  let cached = jwksCache.get(issuer);
  if (
    !cached ||
    cached.expires < now ||
    (!cached.keys.some((k) => k.kid === kid) && now - cached.fetched > 60000)
  ) {
    let raw;
    try {
      const res = await fetch(issuer + '/cdn-cgi/access/certs', {
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw unauthorized('SIGNING_KEYS_FETCH_FAILED');
      raw = await res.text();
    } catch {
      throw unauthorized('SIGNING_KEYS_FETCH_FAILED');
    }
    try {
      if (raw.length > 131072) throw unauthorized('SIGNING_KEYS_INVALID');
      const data = JSON.parse(raw);
      if (
        !Array.isArray(data.keys) ||
        data.keys.length > 20 ||
        data.keys.some((k) => !k || typeof k !== 'object' || Array.isArray(k))
      )
        throw unauthorized('SIGNING_KEYS_INVALID');
      cached = { keys: data.keys, fetched: now, expires: now + 300000 };
      jwksCache.set(issuer, cached);
      if (jwksCache.size > 10) jwksCache.delete(jwksCache.keys().next().value);
    } catch {
      throw unauthorized('SIGNING_KEYS_INVALID');
    }
  }
  const matches = cached.keys.filter(
    (k) =>
      k.kid === kid &&
      k.kty === 'RSA' &&
      (!k.alg || k.alg === 'RS256') &&
      (!k.use || k.use === 'sig')
  );
  if (matches.length !== 1) throw unauthorized('SIGNING_KEY_NOT_FOUND');
  try {
    const size = decodePart(matches[0].n).length;
    if (size < 256 || size > 1024) throw unauthorized('SIGNING_KEY_INVALID');
    return await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: matches[0].n, e: matches[0].e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
  } catch {
    throw unauthorized('SIGNING_KEY_INVALID');
  }
}
function setting(env, name, missingReason, invalidReason) {
  const value = env[name];
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim()))
    throw unauthorized(missingReason);
  if (typeof value !== 'string') throw unauthorized(invalidReason);
  return value;
}
async function validateAccess(request, env) {
  let issuer, allowed;
  const team = setting(
    env,
    'CF_ACCESS_TEAM_DOMAIN',
    'CONFIG_TEAM_DOMAIN_MISSING',
    'CONFIG_TEAM_DOMAIN_INVALID'
  );
  try {
    const url = new URL(team);
    if (
      url.protocol !== 'https:' ||
      !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw unauthorized('CONFIG_TEAM_DOMAIN_INVALID');
    issuer = url.origin;
  } catch {
    throw unauthorized('CONFIG_TEAM_DOMAIN_INVALID');
  }
  const audience = setting(
    env,
    'CF_ACCESS_AUD',
    'CONFIG_AUDIENCE_MISSING',
    'CONFIG_AUDIENCE_INVALID'
  );
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(audience)) throw unauthorized('CONFIG_AUDIENCE_INVALID');
  const allowlist = setting(
    env,
    'ADMIN_EMAIL_ALLOWLIST',
    'CONFIG_ALLOWLIST_MISSING',
    'CONFIG_ALLOWLIST_INVALID'
  );
  try {
    allowed = JSON.parse(allowlist);
    if (
      !Array.isArray(allowed) ||
      !allowed.length ||
      allowed.length > 20 ||
      !allowed.every((e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    )
      throw unauthorized('CONFIG_ALLOWLIST_INVALID');
  } catch {
    throw unauthorized('CONFIG_ALLOWLIST_INVALID');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw unauthorized('JWT_HEADER_MISSING');
  const { header, claims, signature, signed } = parseJwt(token);
  if (
    header.alg !== 'RS256' ||
    typeof header.kid !== 'string' ||
    !/^[A-Za-z0-9_:.=-]{1,128}$/.test(header.kid) ||
    header.crit !== undefined ||
    (header.typ !== undefined && header.typ !== 'JWT')
  )
    throw unauthorized('JWT_HEADER_INVALID');
  checkClaims(claims, issuer, audience);
  const key = await signingKey(issuer, header.kid);
  let valid = false;
  try {
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  } catch {}
  if (!valid) throw unauthorized('JWT_SIGNATURE_INVALID');
  if (claims.type !== 'app' || typeof claims.email !== 'string')
    throw unauthorized('JWT_CLAIMS_INVALID');
  const email = claims.email.toLowerCase();
  if (!allowed.map((e) => e.toLowerCase()).includes(email)) {
    const error = new CommerceError(
      'admin_forbidden',
      'This identity is not authorized for product administration.',
      403
    );
    failureReasons.set(error, 'IDENTITY_NOT_ALLOWED');
    throw error;
  }
  return { sub: claims.sub, email, source: 'cloudflare_access' };
}
export async function authenticateAdmin(request, env) {
  try {
    return await validateAccess(request, env);
  } catch (error) {
    // Never pass request, settings, claims, key data or Error objects to a logger.
    // The switch is server-only and cannot be enabled through request input.
    if (env.ADMIN_AUTH_DIAGNOSTICS_ENABLED === 'true') {
      try {
        console.warn('ADMIN_AUTH_' + (failureReasons.get(error) || 'INTERNAL_FAILURE'));
      } catch {
        // Logging must never change the authentication decision.
      }
    }
    throw error;
  }
}
