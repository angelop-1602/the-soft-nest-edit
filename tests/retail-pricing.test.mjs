import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pricingPolicy, assessRetail, priceBasket } from '../src/retail-pricing.js';
import { suggestedRetailCents } from '../src/commerce-math.js';
import { policy } from './helpers/d1.mjs';

test('pricing has no implicit policy and validates every monetary/fee setting', () => {
  assert.throws(() => pricingPolicy({}));
  for (const override of [
    { processingFixedCents: 1.5 },
    { targetMarginBps: 9500 },
    { perItemBufferCents: -1 },
    { maxTotalCents: 0 },
    { version: '<script>' },
    { processingVariableBps: null }
  ]) {
    assert.throws(() =>
      pricingPolicy({
        RETAIL_PRICING_POLICY: JSON.stringify({ ...policy, ...override })
      })
    );
  }
  assert.deepEqual(pricingPolicy({ RETAIL_PRICING_POLICY: JSON.stringify(policy) }), policy);
});
test('pricing includes verified freight, quantities, margin, processing and buffers in cents', () => {
  const lines = [
    { unitPriceCents: 2500, supplierCostCents: 1000, quantity: 2 },
    { unitPriceCents: 4000, supplierCostCents: 1500, quantity: 1 }
  ];
  const result = priceBasket(lines, 471, policy);
  assert.equal(result.subtotalCents, 9000);
  assert.equal(result.shippingCents, 1083);
  assert.equal(result.totalCents, 10083);
  // Verify the desired net margin after rounding the variable processing fee up.
  const fees =
    policy.processingFixedCents +
    Math.ceil((result.totalCents * policy.processingVariableBps) / 10000);
  const net = result.totalCents - 3500 - 471 - fees - 3 * 200 - 200;
  assert.ok(net / result.totalCents >= 0.3);
  assert.equal(priceBasket(lines, null, policy), null);
  assert.equal(priceBasket([{ ...lines[0], supplierCostCents: null }], 471, policy), null);
  assert.equal(priceBasket(lines, 471, { ...policy, maxTotalCents: 100 }), null);
});
test('integer retail calculation rounds up even on exact fractional boundaries and rejects overflow', () => {
  for (const cost of [1, 2, 99, 1001, 9999999]) {
    const value = suggestedRetailCents({
      supplierCostCents: cost,
      freightCents: 0,
      processingFixedCents: 0,
      processingVariableBps: 349,
      targetMarginBps: 3000,
      riskBufferCents: 0
    });
    const expected = Number((BigInt(cost) * 10000n + 6650n) / 6651n);
    assert.equal(value, expected);
  }
  assert.equal(
    suggestedRetailCents({
      supplierCostCents: Number.MAX_SAFE_INTEGER,
      freightCents: 1,
      processingFixedCents: 1,
      processingVariableBps: 1,
      targetMarginBps: 1,
      riskBufferCents: 1
    }),
    null
  );
  const free = priceBasket([{ unitPriceCents: 1000, supplierCostCents: 100, quantity: 1 }], 0, {
    ...policy,
    processingFixedCents: 0,
    processingVariableBps: 0,
    shippingBufferCents: 0
  });
  assert.equal(free.shippingCents, 0);
});
test('approval requires verified cost, matched approval version, recent inventory and origin', () => {
  const now = Date.now(),
    date = new Date(now).toISOString();
  const row = {
    product_active: 1,
    product_review_state: 'approved',
    review_state: 'approved',
    review_version: 0,
    approved_review_version: 0,
    variant_active: 1,
    supplier_cost_cents: 1000,
    approved_supplier_cost_cents: 1000,
    supplier_cost_verified_at: date,
    retail_price_cents: 2500,
    retail_verified_at: date,
    retail_policy_version: policy.version,
    inventory_quantity: 3,
    inventory_verified_at: date,
    origin_country_code: 'US'
  };
  assert.equal(assessRetail(row, 2, policy, now), null);
  for (const [patch, reason] of [
    [{ product_active: 0 }, 'not_approved'],
    [{ supplier_cost_cents: null }, 'cost_verification_required'],
    [
      { supplier_cost_verified_at: new Date(now - 86400001).toISOString() },
      'cost_verification_required'
    ],
    [{ approved_supplier_cost_cents: 999 }, 'retail_price_unverified'],
    [{ retail_policy_version: 'old' }, 'retail_price_unverified'],
    [{ retail_price_cents: 100 }, 'retail_price_unverified'],
    [{ inventory_quantity: null }, 'inventory_unverified'],
    [{ inventory_quantity: 1 }, 'insufficient_inventory'],
    [
      { inventory_verified_at: new Date(now + 1000).toISOString() },
      'inventory_not_recently_verified'
    ],
    [{ origin_country_code: null }, 'warehouse_unverified']
  ])
    assert.equal(assessRetail({ ...row, ...patch }, 2, policy, now), reason);
});
