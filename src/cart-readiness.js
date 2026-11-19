/**
 * Public read-only cart pricing-readiness check. Uses D1 server-authoritative
 * records; never quotes unreviewed retail prices. DOES NOT charge customers or
 * call CJ. Every response explicitly disables checkout/fulfillment.
 */
const VALID_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LINES = 15;
const MAX_QTY = 5;
const MAX_BODY = 4000;
const INVENTORY_FRESH_MS = 24 * 60 * 60 * 1000;
const JSON_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer'
});
const respond = (json, status = 200) => Response.json(json, { status, headers: JSON_HEADERS });

export function validateItems(value) {
  if (!value || !Array.isArray(value.items) || value.items.length > MAX_LINES) return null;
  const seen = new Set();
  const clean = [];
  for (const item of value.items) {
    if (!item || typeof item.variantId !== 'string' || !VALID_ID.test(item.variantId)
      || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QTY
      || seen.has(item.variantId)) return null;
    seen.add(item.variantId);
    clean.push({ variantId: item.variantId, quantity: item.quantity });
  }
  return clean;
}

function verifiedDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? value.replace(' ', 'T') + 'Z' : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function assessVariant(row, requestedQty, nowMs) {
  if (!row) return { reason: 'not_found', retailPriceCents: null };
  if (row.product_active !== 1 || row.variant_active !== 1)
    return { reason: 'not_approved', retailPriceCents: null };
  if (!Number.isSafeInteger(row.retail_price_cents) || row.retail_price_cents < 1
    || !verifiedDate(row.retail_verified_at))
    return { reason: 'retail_price_unverified', retailPriceCents: null };
  if (!Number.isSafeInteger(row.inventory_quantity) || row.inventory_quantity < 0)
    return { reason: 'inventory_unverified', retailPriceCents: null };
  if (row.inventory_quantity < requestedQty)
    return { reason: 'insufficient_inventory', retailPriceCents: null };
  const checkedMs = verifiedDate(row.inventory_verified_at);
  if (checkedMs === null || checkedMs > nowMs || nowMs - checkedMs > INVENTORY_FRESH_MS)
    return { reason: 'inventory_not_recently_verified', retailPriceCents: null };
  return { reason: 'shipping_not_quoted', retailPriceCents: row.retail_price_cents };
}

export async function checkCartReadiness(db, items, nowMs = Date.now()) {
  const result = [];
  let subtotalCents = 0;
  let approvedItems = 0;
  for (const item of items) {
    const row = await db.prepare(`SELECT v.retail_price_cents, v.inventory_quantity,
      v.active AS variant_active, v.retail_verified_at, v.inventory_verified_at,
      p.active AS product_active
      FROM cj_variants v JOIN cj_products p ON p.id = v.product_id
      WHERE v.cj_variant_id = ? LIMIT 1`).bind(item.variantId).first();
    const checked = assessVariant(row, item.quantity, nowMs);
    if (checked.retailPriceCents !== null) {
      subtotalCents += checked.retailPriceCents * item.quantity;
      approvedItems++;
    }
    result.push({ variantId: item.variantId, quantity: item.quantity,
      reason: checked.reason,
      unitPriceUsd: checked.retailPriceCents === null ? null : (checked.retailPriceCents / 100).toFixed(2) });
  }
  const allReadyForShipping = items.length > 0 && approvedItems === items.length;
  return {
    kind: 'cj_checkout_readiness',
    currency: 'USD',
    customerCheckoutEnabled: false,
    paypalCaptureEnabled: false,
    cjOrderSubmissionEnabled: false,
    productsApprovedForShippingQuote: allReadyForShipping,
    lines: result,
    subtotalUsd: allReadyForShipping ? (subtotalCents / 100).toFixed(2) : null,
    shippingUsd: null,
    grandTotalUsd: null,
    nextAction: allReadyForShipping ? 'verify_destination_shipping_and_payment_flow' : 'await_product_and_inventory_verification'
  };
}

export async function handleCheckoutReadiness(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405);
  if (request.headers.get('Origin') !== url.origin) return respond({ error: 'Origin rejected' }, 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || ''))
    return respond({ error: 'JSON required' }, 415);
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) return respond({ error: 'Cart too large' }, 413);
  let raw;
  try { raw = await request.text(); } catch { return respond({ error: 'Invalid request' }, 400); }
  if (raw.length > MAX_BODY) return respond({ error: 'Cart too large' }, 413);
  let payload;
  try { payload = JSON.parse(raw); } catch { return respond({ error: 'Invalid JSON' }, 400); }
  const items = validateItems(payload);
  if (items === null) return respond({ error: 'Invalid cart' }, 400);
  try {
    if (!env.DB || typeof env.DB.prepare !== 'function') throw new Error('Missing database');
    return respond(await checkCartReadiness(env.DB, items));
  } catch { return respond({ error: 'Pricing readiness temporarily unavailable' }, 503); }
}
