import { suggestedRetailCents } from './commerce-math.js';
import { CommerceError } from './commerce-security.js';

const cents = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 999999999;
export const recent = (value, now, maxAge = 86400000) => {
  if (typeof value !== 'string') return false;
  const stamp = Date.parse(
    /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
  );
  return Number.isFinite(stamp) && stamp <= now && now - stamp <= maxAge;
};
/** No implicit pricing policy: an operator must configure and approve a version. */
export function pricingPolicy(env) {
  let p;
  try {
    p = JSON.parse(env.RETAIL_PRICING_POLICY || 'null');
  } catch {
    p = null;
  }
  if (
    !p ||
    !/^[a-zA-Z0-9_-]{1,40}$/.test(p.version || '') ||
    !['processingFixedCents', 'perItemBufferCents', 'shippingBufferCents', 'maxTotalCents'].every(
      (k) => cents(p[k])
    ) ||
    !['processingVariableBps', 'targetMarginBps'].every(
      (k) => Number.isInteger(p[k]) && p[k] >= 0
    ) ||
    p.processingVariableBps + p.targetMarginBps >= 9500 ||
    p.maxTotalCents < 100
  )
    throw new CommerceError(
      'pricing_unavailable',
      'Retail pricing is awaiting configuration.',
      503
    );
  if (
    (p.markupBps !== undefined &&
      (!Number.isInteger(p.markupBps) || p.markupBps < 0 || p.markupBps > 100000)) ||
    (p.allowMarginExceptions !== undefined && typeof p.allowMarginExceptions !== 'boolean') ||
    (p.allowMarginExceptions === true &&
      (!Number.isInteger(p.exceptionMinimumMarginBps) ||
        p.exceptionMinimumMarginBps < 0 ||
        p.exceptionMinimumMarginBps > p.targetMarginBps ||
        !Number.isInteger(p.exceptionMaxHours) ||
        p.exceptionMaxHours < 1 ||
        p.exceptionMaxHours > 168))
  )
    throw new CommerceError('pricing_unavailable', 'Pricing policy settings are invalid.', 400);
  // Canonical order, no unvalidated settings in persisted snapshots.
  return {
    version: p.version,
    processingFixedCents: p.processingFixedCents,
    processingVariableBps: p.processingVariableBps,
    targetMarginBps: p.targetMarginBps,
    perItemBufferCents: p.perItemBufferCents,
    shippingBufferCents: p.shippingBufferCents,
    maxTotalCents: p.maxTotalCents,
    ...(p.markupBps !== undefined ? { markupBps: p.markupBps } : {}),
    ...(p.allowMarginExceptions !== undefined
      ? { allowMarginExceptions: p.allowMarginExceptions }
      : {}),
    ...(p.allowMarginExceptions === true
      ? {
          exceptionMinimumMarginBps: p.exceptionMinimumMarginBps,
          exceptionMaxHours: p.exceptionMaxHours
        }
      : {})
  };
}
export async function pricingPolicyState(env) {
  const row = await env.DB.prepare(
    'SELECT revision,policy_json FROM admin_pricing_policy WHERE id=1'
  ).first();
  let policy = null;
  try {
    policy = pricingPolicy(row?.policy_json ? { RETAIL_PRICING_POLICY: row.policy_json } : env);
  } catch {}
  return { revision: row?.revision ?? 0, policy };
}
export async function loadPricingPolicy(env) {
  const { policy } = await pricingPolicyState(env);
  if (!policy)
    throw new CommerceError(
      'pricing_unavailable',
      'Retail pricing is awaiting configuration.',
      503
    );
  return policy;
}
export function minimumUnitRetail(cost, policy) {
  const margin = suggestedRetailCents({
    supplierCostCents: cost,
    freightCents: 0,
    processingFixedCents: 0,
    processingVariableBps: policy.processingVariableBps,
    targetMarginBps: policy.targetMarginBps,
    riskBufferCents: policy.perItemBufferCents
  });
  if (margin === null) return null;
  const base = BigInt(cost) + BigInt(policy.perItemBufferCents);
  const markup = Number((base * BigInt(10000 + (policy.markupBps || 0)) + 9999n) / 10000n);
  return Math.max(margin, markup);
}
export function effectiveRetailPolicy(row, policy, now = Date.now()) {
  if (!row.pricing_exception_json) return policy;
  try {
    const ex = JSON.parse(row.pricing_exception_json);
    if (
      policy.allowMarginExceptions !== true ||
      ex.acknowledged !== true ||
      !ex.id ||
      !ex.actor ||
      ex.policyJson !== JSON.stringify(policy) ||
      ex.costCents !== row.supplier_cost_cents ||
      ex.priceCents !== row.retail_price_cents ||
      !Number.isInteger(ex.minimumMarginBps) ||
      ex.minimumMarginBps < policy.exceptionMinimumMarginBps ||
      ex.minimumMarginBps > policy.targetMarginBps ||
      !Number.isSafeInteger(ex.createdMs) ||
      ex.createdMs > now ||
      !Number.isSafeInteger(ex.expiresMs) ||
      ex.expiresMs <= now ||
      ex.expiresMs - ex.createdMs > policy.exceptionMaxHours * 3600000 ||
      typeof ex.reason !== 'string' ||
      ex.reason.trim().length < 20
    )
      return null;
    return { ...policy, targetMarginBps: ex.minimumMarginBps, markupBps: 0 };
  } catch {
    return null;
  }
}
export function assessRetail(row, qty, policy, now = Date.now()) {
  if (!row) return 'not_found';
  if (row.fixture_only === 1 || row.product_fixture_only === 1) return 'fixture_not_for_sale';
  if (row.product_active !== 1 || row.variant_active !== 1) return 'not_approved';
  if (
    row.product_review_state !== 'approved' ||
    row.review_state !== 'approved' ||
    row.approved_review_version !== row.review_version
  )
    return 'not_approved';
  if (
    !cents(row.supplier_cost_cents) ||
    row.supplier_cost_cents < 1 ||
    !recent(row.supplier_cost_verified_at, now)
  )
    return 'cost_verification_required';
  if (
    !policy ||
    !cents(row.retail_price_cents) ||
    row.retail_price_cents < 1 ||
    !recent(row.retail_verified_at, now, 365 * 86400000) ||
    row.approved_supplier_cost_cents !== row.supplier_cost_cents ||
    row.retail_policy_version !== policy.version
  )
    return 'retail_price_unverified';
  const effective = effectiveRetailPolicy(row, policy, now);
  const floor = effective ? minimumUnitRetail(row.supplier_cost_cents, effective) : null;
  if (!floor || row.retail_price_cents < floor) return 'retail_price_unverified';
  if (!Number.isSafeInteger(row.inventory_quantity) || row.inventory_quantity < 0)
    return 'inventory_unverified';
  if (row.inventory_quantity < qty) return 'insufficient_inventory';
  if (!recent(row.inventory_verified_at, now)) return 'inventory_not_recently_verified';
  if (!['CN', 'US'].includes(row.origin_country_code)) return 'warehouse_unverified';
  return null;
}
/** Freight is private; the customer sees only the policy's retail shipping charge. */
export function priceBasket(lines, freightCents, policy) {
  if (!Array.isArray(lines) || !lines.length || !cents(freightCents)) return null;
  let subtotalCents = 0,
    supplierCostCents = 0,
    count = 0,
    minimumProducts = 0,
    hasException = false;
  for (const line of lines) {
    if (
      !cents(line.unitPriceCents) ||
      line.unitPriceCents < 1 ||
      !cents(line.supplierCostCents) ||
      line.supplierCostCents < 1 ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 5
    )
      return null;
    const effective = effectiveRetailPolicy(
      {
        supplier_cost_cents: line.supplierCostCents,
        retail_price_cents: line.unitPriceCents,
        pricing_exception_json: line.pricingExceptionJson
      },
      policy
    );
    if (!effective) return null;
    const floor = minimumUnitRetail(line.supplierCostCents, effective);
    if (floor === null || line.unitPriceCents < floor) return null;
    minimumProducts += floor * line.quantity;
    hasException ||= Boolean(line.pricingExceptionJson);
    subtotalCents += line.unitPriceCents * line.quantity;
    supplierCostCents += line.supplierCostCents * line.quantity;
    count += line.quantity;
  }
  const shippingCents =
    freightCents + policy.processingFixedCents + policy.shippingBufferCents === 0
      ? 0
      : suggestedRetailCents({
          supplierCostCents: 0,
          freightCents,
          processingFixedCents: policy.processingFixedCents,
          processingVariableBps: policy.processingVariableBps,
          targetMarginBps: policy.targetMarginBps,
          riskBufferCents: policy.shippingBufferCents
        });
  // A verified free supplier rate may still have handling/processing policy costs.
  if (shippingCents === null) return null;
  const totalCents = subtotalCents + shippingCents;
  const minimum = hasException
    ? minimumProducts + shippingCents
    : suggestedRetailCents({
        supplierCostCents,
        freightCents,
        processingFixedCents: policy.processingFixedCents,
        processingVariableBps: policy.processingVariableBps,
        targetMarginBps: policy.targetMarginBps,
        riskBufferCents: count * policy.perItemBufferCents + policy.shippingBufferCents
      });
  return cents(totalCents) &&
    totalCents <= policy.maxTotalCents &&
    minimum !== null &&
    totalCents >= minimum
    ? { subtotalCents, shippingCents, totalCents }
    : null;
}
