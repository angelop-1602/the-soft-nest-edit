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
const unauthorized = () =>
  new CommerceError('admin_unauthorized', 'Administrator sign-in is required.', 401);
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
  if (
    claims.iss !== issuer ||
    !aud.includes(audience) ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= now ||
    !Number.isInteger(claims.iat) ||
    claims.iat > now + 30 ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 86400 ||
    (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now)) ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    claims.sub.length > 200
  )
    throw unauthorized();
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
    try {
      const res = await fetch(issuer + '/cdn-cgi/access/certs', {
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw unauthorized();
      const raw = await res.text();
      if (raw.length > 131072) throw unauthorized();
      const data = JSON.parse(raw);
      if (!Array.isArray(data.keys) || data.keys.length > 20) throw unauthorized();
      cached = { keys: data.keys, fetched: now, expires: now + 300000 };
      jwksCache.set(issuer, cached);
      if (jwksCache.size > 10) jwksCache.delete(jwksCache.keys().next().value);
    } catch {
      throw unauthorized();
    }
  }
  const matches = cached.keys.filter(
    (k) =>
      k.kid === kid &&
      k.kty === 'RSA' &&
      (!k.alg || k.alg === 'RS256') &&
      (!k.use || k.use === 'sig')
  );
  if (
    matches.length !== 1 ||
    decodePart(matches[0].n).length < 256 ||
    decodePart(matches[0].n).length > 1024
  )
    throw unauthorized();
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: matches[0].n, e: matches[0].e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}
export async function authenticateAdmin(request, env) {
  let issuer, allowed;
  try {
    const url = new URL(env.CF_ACCESS_TEAM_DOMAIN);
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
      throw unauthorized();
    issuer = url.origin;
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(env.CF_ACCESS_AUD || '')) throw unauthorized();
    allowed = JSON.parse(env.ADMIN_EMAIL_ALLOWLIST || 'null');
    if (
      !Array.isArray(allowed) ||
      !allowed.length ||
      allowed.length > 20 ||
      !allowed.every((e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    )
      throw unauthorized();
  } catch {
    throw unauthorized();
  }
  const { header, claims, signature, signed } = parseJwt(
    request.headers.get('Cf-Access-Jwt-Assertion')
  );
  if (
    header.alg !== 'RS256' ||
    typeof header.kid !== 'string' ||
    !/^[A-Za-z0-9_:.=-]{1,128}$/.test(header.kid) ||
    header.crit !== undefined ||
    (header.typ !== undefined && header.typ !== 'JWT')
  )
    throw unauthorized();
  checkClaims(claims, issuer, env.CF_ACCESS_AUD);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      await signingKey(issuer, header.kid),
      signature,
      signed
    );
  } catch {}
  if (!valid || claims.type !== 'app' || typeof claims.email !== 'string') throw unauthorized();
  const email = claims.email.toLowerCase();
  if (!allowed.map((e) => e.toLowerCase()).includes(email))
    throw new CommerceError(
      'admin_forbidden',
      'This identity is not authorized for product administration.',
      403
    );
  return { sub: claims.sub, email, source: 'cloudflare_access' };
}
