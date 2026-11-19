import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  prepareFulfillmentDraft,
  submitSupplierOrder,
  paySupplierOrder,
  validateShippingAddress
} from '../src/fulfillment.js';
import { fixtureEnv, seed } from './helpers/d1.mjs';

test('fulfillment requires paid live order and exact selections; execution is unconditionally disabled', async () => {
  const address = {
    name: 'Example Test',
    line1: '123 Example Street',
    city: 'New York',
    state: 'NY',
    zip: '10001',
    countryCode: 'US'
  };
  const order = {
    id: 'ORDER01',
    environment: 'live',
    status: 'paid',
    items: [{ variantId: 'EXACT-VID', quantity: 2 }],
    shippingAddress: address,
    shippingMethod: { carrier: 'Verified method' }
  };
  const draft = prepareFulfillmentDraft(order);
  assert.equal(draft.status, 'disabled');
  assert.equal(draft.idempotencyKey, 'cj-order-ORDER01');
  assert.deepEqual(draft.items, order.items);
  assert.equal(prepareFulfillmentDraft({ ...order, environment: 'sandbox' }), null);
  assert.equal(prepareFulfillmentDraft({ ...order, status: 'pending_payment' }), null);
  assert.equal(validateShippingAddress({ ...address, state: 'XX' }), null);
  assert.equal(validateShippingAddress({ ...address, line1: 'a\nprivate' }), null);
  await assert.rejects(submitSupplierOrder(), /CJ_FULFILLMENT_DISABLED/);
  await assert.rejects(paySupplierOrder(), /CJ_SUPPLIER_PAYMENT_DISABLED/);
});
test('migration preserves existing Sandbox constraints and invalidates approval when cost changes', async () => {
  const env = fixtureEnv();
  await seed(env);
  await env.DB.prepare('UPDATE cj_variants SET supplier_cost_cents=1100').run();
  const row = await env.DB.prepare(
    'SELECT retail_verified_at,approved_supplier_cost_cents,retail_policy_version FROM cj_variants'
  ).first();
  assert.equal(row.retail_verified_at, null);
  assert.equal(row.approved_supplier_cost_cents, null);
  assert.equal(row.retail_policy_version, null);
});
