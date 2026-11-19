import worker from '../../src/index.js';
import { fixtureEnv, seed, request, cjMock } from './d1.mjs';

const pair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  },
  true,
  ['sign', 'verify']
);
const jwk = {
  ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
  kid: 'softnest-test-key',
  alg: 'RS256',
  use: 'sig'
};
export const team = 'https://softnest-test-admin.cloudflareaccess.com',
  aud = 'a'.repeat(64),
  actorEmail = 'owner@example.test';
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
export async function jwt(overrides = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: jwk.kid, ...headerOverrides })
  );
  const claims = b64(
    JSON.stringify({
      iss: team,
      aud: [aud],
      sub: 'test-owner-001',
      email: actorEmail,
      type: 'app',
      iat: now,
      exp: now + 3600,
      ...overrides
    })
  );
  const signed = header + '.' + claims;
  return (
    signed +
    '.' +
    b64(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(signed)
      )
    )
  );
}
export function authEnv() {
  return {
    ...fixtureEnv(),
    CF_ACCESS_TEAM_DOMAIN: team,
    CF_ACCESS_AUD: aud,
    ADMIN_EMAIL_ALLOWLIST: JSON.stringify([actorEmail])
  };
}
export async function adminRequest(path, body, options = {}) {
  return request('/api/admin/' + path, body, {
    ...options,
    headers: { 'Cf-Access-Jwt-Assertion': await jwt(), 'X-Softnest-Admin': '1', ...options.headers }
  });
}
export function externalMock(overrides = {}) {
  return async (raw, init) =>
    new URL(raw).href === team + '/cdn-cgi/access/certs'
      ? Response.json({ keys: [jwk] })
      : cjMock({ variantSku: 'MOCK-SKU', variantKey: 'Natural linen', ...overrides })(raw, init);
}
export async function call(env, path, body, options = {}) {
  const res = await worker.fetch(await adminRequest(path, body, options), env);
  const value = await res.json();
  if (!res.ok)
    throw Object.assign(new Error(value.error), { status: res.status, code: value.code });
  return value;
}
export async function pending(env, opts = {}) {
  await seed(env, { active: 0, ...opts });
  return call(env, 'products/' + (opts.pid || 'TEST-P1'));
}
export const qualityReview = {
  photosAccurate: true,
  descriptionAccurate: true,
  sizeMaterialsVerified: true,
  returnsReviewed: true,
  restrictionsReviewed: true,
  supplierReviewed: true,
  complaintsReviewed: true,
  returnEligibility: 'eligible',
  restrictionStatus: 'clear',
  returnNotes: 'Inspected the supplier return conditions and documented product defect handling.',
  sizeMaterialNotes: '45 cm woven linen shell with reviewed dimensions.',
  supplierNotes: 'Test supplier reviewed.',
  complaintsNotes: 'No defects in this synthetic test.',
  restrictionNotes: 'Ordinary textile test fixture, no restricted goods.'
};
export const variantReview = {
  mappingReviewed: true,
  optionsReviewed: true,
  restrictionsReviewed: true,
  notes: 'Exact test variant reviewed.'
};
export function versions(d) {
  return { expectedProductVersion: d.product.version, expectedVersion: d.variants[0].version };
}
export async function reviewed(env, { approve = false, retail = '25.00' } = {}) {
  let d = await pending(env);
  d = await call(env, 'products/TEST-P1/variants/TEST-V1/verify', { ...versions(d), origin: 'US' });
  d = await call(env, 'products/TEST-P1/review', {
    expectedVersion: d.product.version,
    description:
      'A natural linen cushion with accurately reviewed 45 cm sizing and textile materials.',
    review: qualityReview
  });
  d = await call(env, 'products/TEST-P1/variants/TEST-V1/review', {
    ...versions(d),
    review: variantReview
  });
  d = await call(env, 'products/TEST-P1/variants/TEST-V1/shipping', {
    ...versions(d),
    zip: '10001',
    quantity: 1
  });
  d = await call(env, 'products/TEST-P1/variants/TEST-V1/price', {
    ...versions(d),
    retailPriceUsd: retail
  });
  if (approve) d = await call(env, 'products/TEST-P1/decision', decision(d));
  return d;
}
export function decision(d, action = 'approve', scope = 'variants') {
  return {
    expectedVersion: d.product.version,
    action,
    scope,
    reason:
      action === 'approve'
        ? 'Reviewed each required approval check.'
        : 'Suspended during an explicit administrative review.',
    variants: d.variants.map((v) => ({ variantId: v.id, expectedVersion: v.version }))
  };
}
