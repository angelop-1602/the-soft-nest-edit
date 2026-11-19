/** CJ freight API 1.1, verified 2026-11-19 against official Logistics/Product docs.
 * Trial quotes only. No supplier order endpoints, costs or raw diagnostics in responses.
 */
import { cjAuthorized } from './cj-client.js';
import { moneyCents, buildCjFreightTrial } from './commerce-math.js';
import { safeImage } from './cj-sync.js';
import { safeVariantOptions } from './catalog-preview.js';
import { validateCartPayload } from './cart-preview.js';
import { loadPricingPolicy, assessRetail, priceBasket } from './retail-pricing.js';
import { CommerceError, digest, validZip } from './commerce-security.js';

export const QUOTE_TTL_MS = 10 * 60 * 1000;
const reasons = {
  not_found: 'This variant is no longer available.',
  fixture_not_for_sale: 'This preview fixture cannot be purchased.',
  not_approved: 'Product review is pending.',
  cost_verification_required: 'Product pricing needs verification.',
  retail_price_unverified: 'Retail pricing needs approval.',
  inventory_unverified: 'Inventory needs verification.',
  insufficient_inventory: 'The requested quantity is unavailable.',
  inventory_not_recently_verified: 'Inventory confirmation has expired.',
  warehouse_unverified: 'The shipping origin needs verification.'
};
export function selections(payload) {
  const items = validateCartPayload(payload);
  if (!items || !items.length)
    throw new CommerceError('invalid_cart', 'Choose 1–15 variants, with quantities from 1–5.', 400);
  return items.sort((a, b) => a.variantId.localeCompare(b.variantId));
}
export async function catalogRows(db, items) {
  const rows = [];
  for (const item of items) {
    const row = await db
      .prepare(
        `SELECT v.*,p.cj_product_id,p.title,p.image_url,
      p.active AS product_active,v.active AS variant_active,
      p.review_state AS product_review_state,p.fixture_only AS product_fixture_only
      FROM cj_variants v JOIN cj_products p ON p.id=v.product_id WHERE v.cj_variant_id=? LIMIT 1`
      )
      .bind(item.variantId)
      .first();
    rows.push({ item, row });
  }
  return rows;
}
export async function cartView(env, items) {
  let policy;
  try {
    policy = await loadPricingPolicy(env);
  } catch {
    policy = null;
  }
  const rows = await catalogRows(env.DB, items);
  const lines = rows.map(({ item, row }) => {
    const reason = assessRetail(row, item.quantity, policy);
    const options = safeVariantOptions(row?.options_json);
    return {
      variantId: item.variantId,
      quantity: item.quantity,
      title: row?.title?.slice(0, 250) || 'Unavailable selection',
      image: safeImage(options.image) || safeImage(row?.image_url),
      variantLabel: options.label || 'Default variant',
      unitPriceCents: reason ? null : row.retail_price_cents,
      reason,
      message: reason ? reasons[reason] : 'Ready for a shipping estimate.'
    };
  });
  const ready = lines.length > 0 && lines.every((l) => l.reason === null);
  return {
    lines,
    currency: 'USD',
    subtotalCents: ready ? lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0) : null,
    shippingCents: null,
    totalCents: null,
    readyForShipping: ready,
    customerCheckoutEnabled: false,
    cjFulfillmentEnabled: false
  };
}
function approvedRows(rows, policy) {
  for (const { item, row } of rows) {
    const reason = assessRetail(row, item.quantity, policy);
    if (reason) throw new CommerceError(reason, reasons[reason]);
  }
}
export async function basketFingerprint(rows, policy, zip) {
  return digest(
    JSON.stringify({
      zip,
      policy,
      lines: rows.map(({ item, row }) => ({
        variantId: item.variantId,
        quantity: item.quantity,
        productId: row.cj_product_id,
        cost: row.supplier_cost_cents,
        approvedCost: row.approved_supplier_cost_cents,
        retail: row.retail_price_cents,
        retailApproval: row.retail_verified_at,
        origin: row.origin_country_code,
        reviewVersion: row.review_version,
        productReviewState: row.product_review_state,
        pricingExceptionJson: row.pricing_exception_json || null
      }))
    })
  );
}
export function freightOptions(data) {
  if (!Array.isArray(data)) return [];
  return data
    .slice(0, 50)
    .flatMap((rate) => {
      if (typeof rate?.logisticName !== 'string' || !rate.logisticName.trim()) return [];
      const base = moneyCents(rate.logisticPrice);
      if (base === null) return [];
      const taxes = rate.taxesFee == null ? 0 : moneyCents(rate.taxesFee);
      const clearance =
        rate.clearanceOperationFee == null ? 0 : moneyCents(rate.clearanceOperationFee);
      const total = rate.totalPostageFee == null ? null : moneyCents(rate.totalPostageFee);
      if (taxes === null || clearance === null || (rate.totalPostageFee != null && total === null))
        return [];
      const cost = total ?? base + taxes + clearance;
      if (cost < base + taxes + clearance || cost > 200000000) return [];
      return [
        {
          carrier: rate.logisticName.trim().slice(0, 80),
          freightCents: cost,
          supplierDeliveryEstimate:
            typeof rate.logisticAging === 'string' ? rate.logisticAging.slice(0, 60) : null
        }
      ];
    })
    .sort((a, b) => a.freightCents - b.freightCents || a.carrier.localeCompare(b.carrier));
}
/** Live CJ data must prove the exact vid, current cost, and stock in the approved origin. */
export async function verifyLiveLines(env, rows) {
  for (const { item, row } of rows) {
    const data = await cjAuthorized(env, '/product/variant/queryByVid', {
      search: { vid: item.variantId, features: 'enable_inventory' }
    });
    if (
      String(data?.vid) !== item.variantId ||
      String(data?.pid) !== row.cj_product_id ||
      moneyCents(data?.variantSellPrice) !== row.approved_supplier_cost_cents
    )
      throw new CommerceError('product_changed', 'Product pricing has changed and needs review.');
    const inventory = Array.isArray(data.inventories)
      ? data.inventories.filter((i) => i.countryCode === row.origin_country_code)
      : [];
    // Never treat factory/unverified stock or a country-wide total as CJ warehouse stock.
    if (
      inventory.length !== 1 ||
      Number(inventory[0].verifiedWarehouse) !== 1 ||
      !Number.isSafeInteger(inventory[0].cjInventory) ||
      inventory[0].cjInventory < item.quantity
    )
      throw new CommerceError(
        'shipping_unavailable',
        'Verified warehouse stock is unavailable for this selection.'
      );
  }
}
export function shippingFailure(error) {
  if (error instanceof CommerceError) return error;
  if (['CJ_RATE_LIMITED', 'CJ_POINTS_EXHAUSTED'].includes(error?.code))
    return new CommerceError(
      'shipping_busy',
      'Shipping estimates are busy. Please try again later.',
      429
    );
  return new CommerceError(
    'shipping_unavailable',
    'Shipping estimates are temporarily unavailable. Please try again later.',
    503
  );
}
export async function quoteShipping(env, owner, items, zip) {
  if (!validZip(zip))
    throw new CommerceError(
      'invalid_zip',
      'Enter a US ZIP code, such as 10001 or 10001-1234.',
      400
    );
  const policy = await loadPricingPolicy(env),
    rows = await catalogRows(env.DB, items);
  approvedRows(rows, policy);
  const fingerprint = await basketFingerprint(rows, policy, zip),
    now = Date.now();
  const cached = await env.DB.prepare(
    `SELECT * FROM commerce_quotes WHERE owner_hash=? AND fingerprint=?
    AND expires_ms>? ORDER BY created_ms DESC LIMIT 1`
  )
    .bind(owner, fingerprint, now)
    .first();
  if (cached) return publicQuote(cached);
  // Per-session cooldown bounds repeated freight calls; the shared CJ gate also
  // bounds all requests globally, even if a visitor rotates session cookies.
  const previous = await env.DB.prepare(
    'SELECT created_ms FROM commerce_quotes WHERE owner_hash=? ORDER BY created_ms DESC LIMIT 1'
  )
    .bind(owner)
    .first();
  if (previous && now - previous.created_ms < 30000)
    throw shippingFailure({ code: 'CJ_RATE_LIMITED' });
  try {
    await verifyLiveLines(env, rows);
    const groups = new Map();
    for (const entry of rows) {
      const key = entry.row.cj_product_id + ':' + entry.row.origin_country_code;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    const shipments = [];
    for (const entries of groups.values()) {
      const origin = entries[0].row.origin_country_code;
      const body = buildCjFreightTrial({
        originCountryCode: origin,
        destinationZip: zip,
        items: entries.map(({ item }) => ({
          vid: item.variantId,
          quantity: item.quantity
        }))
      });
      if (!body) throw new CommerceError('shipping_unavailable', 'Shipping could not be verified.');
      const data = await cjAuthorized(env, '/logistic/freightCalculate', {
        method: 'POST',
        body
      });
      const best = freightOptions(data)[0];
      if (!best)
        throw new CommerceError(
          'shipping_unavailable',
          'No supported shipping method is available for this destination.'
        );
      shipments.push({
        ...best,
        origin,
        variantIds: entries.map(({ item }) => item.variantId)
      });
    }
    const lines = rows.map(({ item, row }) => ({
      variantId: item.variantId,
      productId: row.cj_product_id,
      quantity: item.quantity,
      title: row.title.slice(0, 250),
      unitPriceCents: row.retail_price_cents,
      supplierCostCents: row.supplier_cost_cents,
      origin: row.origin_country_code,
      pricingExceptionJson: row.pricing_exception_json || null
    }));
    const prices = priceBasket(
      lines,
      shipments.reduce((s, r) => s + r.freightCents, 0),
      policy
    );
    if (!prices)
      throw new CommerceError(
        'retail_price_unverified',
        'The complete price needs merchant review.'
      );
    // Detect approval/price edits while the external requests were in flight.
    const current = await catalogRows(env.DB, items);
    approvedRows(current, policy);
    if ((await basketFingerprint(current, policy, zip)) !== fingerprint)
      throw new CommerceError(
        'product_changed',
        'Product details changed. Please refresh your cart.'
      );
    const record = {
      id: crypto.randomUUID(),
      ...prices,
      created_ms: Date.now(),
      expires_ms: Date.now() + QUOTE_TTL_MS,
      snapshot_json: JSON.stringify({ lines, shipments, items, zip })
    };
    await env.DB.prepare(
      `INSERT INTO commerce_quotes(id,owner_hash,fingerprint,policy_json,destination_zip,
      snapshot_json,subtotal_cents,shipping_cents,total_cents,created_ms,expires_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        record.id,
        owner,
        fingerprint,
        JSON.stringify(policy),
        zip,
        record.snapshot_json,
        prices.subtotalCents,
        prices.shippingCents,
        prices.totalCents,
        record.created_ms,
        record.expires_ms
      )
      .run();
    return publicQuote({
      ...record,
      subtotal_cents: prices.subtotalCents,
      shipping_cents: prices.shippingCents,
      total_cents: prices.totalCents
    });
  } catch (error) {
    throw shippingFailure(error);
  }
}
export function publicQuote(record) {
  const snapshot = JSON.parse(record.snapshot_json);
  return {
    quoteId: record.id,
    currency: 'USD',
    subtotalCents: record.subtotal_cents,
    shippingCents: record.shipping_cents,
    totalCents: record.total_cents,
    expiresMs: record.expires_ms,
    preliminary: true,
    customerCheckoutEnabled: false,
    cjFulfillmentEnabled: false,
    shipments: snapshot.shipments.map((s) => ({
      carrier: s.carrier,
      supplierDeliveryEstimate: s.supplierDeliveryEstimate
    })),
    notice:
      'Estimated retail shipping, including handling. Supplier transit estimates are not delivery guarantees. Taxes are not calculated. Purchases remain disabled.'
  };
}
export async function validateQuote(env, owner, id, { live = false } = {}) {
  const quote = await env.DB.prepare('SELECT * FROM commerce_quotes WHERE id=? AND owner_hash=?')
    .bind(id, owner)
    .first();
  if (!quote || quote.expires_ms <= Date.now())
    throw new CommerceError(
      'quote_expired',
      'Request a fresh shipping estimate before testing checkout.'
    );
  const policy = await loadPricingPolicy(env),
    snapshot = JSON.parse(quote.snapshot_json);
  const items = selections({ items: snapshot.items }),
    rows = await catalogRows(env.DB, items);
  approvedRows(rows, policy);
  if (
    JSON.stringify(policy) !== quote.policy_json ||
    (await basketFingerprint(rows, policy, quote.destination_zip)) !== quote.fingerprint
  )
    throw new CommerceError(
      'quote_changed',
      'Product approval or pricing changed. Request a fresh estimate.'
    );
  const prices = priceBasket(
    snapshot.lines,
    snapshot.shipments.reduce((s, r) => s + r.freightCents, 0),
    policy
  );
  if (
    !prices ||
    prices.totalCents !== quote.total_cents ||
    prices.subtotalCents !== quote.subtotal_cents ||
    prices.shippingCents !== quote.shipping_cents
  )
    throw new CommerceError('quote_changed', 'This estimate needs to be refreshed.');
  if (live) {
    try {
      await verifyLiveLines(env, rows);
    } catch (error) {
      throw shippingFailure(error);
    }
    const current = await catalogRows(env.DB, items);
    approvedRows(current, policy);
    if (
      quote.expires_ms <= Date.now() ||
      (await basketFingerprint(current, policy, quote.destination_zip)) !== quote.fingerprint
    )
      throw new CommerceError(
        'quote_changed',
        'This estimate changed or expired. Request a fresh estimate.'
      );
  }
  return quote;
}
