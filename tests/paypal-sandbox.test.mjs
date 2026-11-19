import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sandboxReady, validateApprovalUrl, isCompletedCapture, handleSandboxPaypal } from '../src/paypal-sandbox.js';
import worker from '../src/index.js';

const origin = 'https://thesoftnestedit.online';
const demoId = '5d6b4a0a-851b-4625-9231-a63219542f22';
const paypalId = '5O190127TN364715T';

function fakeDb() {
  const state = { rows: new Map(), accesses: [] };
  return {
    state,
    prepare(sql) {
      state.accesses.push(sql);
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.includes('INSERT INTO sandbox_checkouts')) {
                state.rows.set(args[0], { id: args[0], status: 'creating', amount_cents: args[1] });
                return { meta: { changes: 1 } };
              }
              const id = args.at(-1);
              const row = state.rows.get(id);
              if (!row) return { meta: { changes: 0 } };
              if (sql.includes("WHERE id=? AND status='created'")) {
                if (row.status !== 'created') return { meta: { changes: 0 } };
                row.status = 'capturing';
              } else if (sql.includes("WHERE id=? AND status='capturing'")) {
                if (row.status !== 'capturing') return { meta: { changes: 0 } };
                row.status = 'paid'; row.paypal_capture_id = args[0];
              } else if (sql.includes("status='created'")) {
                row.status = 'created'; row.paypal_order_id = args[0];
              } else if (sql.includes('SET status=?')) {
                row.status = args[0];
              } else throw new Error('Unexpected SQL: ' + sql);
              return { meta: { changes: 1 } };
            },
            async first() {
              const row = state.rows.get(args[0]);
              return row || null;
            }
          };
        }
      };
    }
  };
}
function env(db = fakeDb()) { return {
  DB: db,
  PAYPAL_MODE: 'sandbox',
  PAYPAL_SANDBOX_CHECKOUT_ENABLED: 'true',
  PAYPAL_SANDBOX_CLIENT_ID: 'sandbox-id',
  PAYPAL_SANDBOX_CLIENT_SECRET: 'hidden-secret',
  PAYPAL_CLIENT_ID: 'LIVE_ID_MUST_NEVER_BE_USED',
  PAYPAL_CLIENT_SECRET: 'LIVE_SECRET_MUST_NEVER_BE_USED',
  CJDROPSHIPPING_API: 'CJ_SECRET_MUST_NEVER_BE_USED'
}; }
function post(path, body = {}) { return new Request(origin + path, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}); }

test('mode and explicit test flag both required; live credentials never enable demo', async () => {
  const e = env();
  assert.equal(sandboxReady(e), true);
  for (const mode of ['live', '', undefined]) {
    e.PAYPAL_MODE = mode;
    assert.equal(sandboxReady(e), false);
    const res = await worker.fetch(post('/api/paypal/sandbox/create'), e);
    assert.equal(res.status, 503);
  }
  e.PAYPAL_MODE = 'sandbox';
  e.PAYPAL_SANDBOX_CHECKOUT_ENABLED = 'false';
  assert.equal(sandboxReady(e), false);
});

test('links fail closed against non-PayPal and non-sandbox domains', () => {
  assert.equal(validateApprovalUrl('https://www.sandbox.paypal.com/checkoutnow?token=abc'),
    'https://www.sandbox.paypal.com/checkoutnow?token=abc');
  for (const url of ['http://www.sandbox.paypal.com/', 'https://www.paypal.com/',
    'https://www.sandbox.paypal.com.evil.com/', 'https://evil.com/',
    'javascript:alert(1)', 'https://u:p@www.sandbox.paypal.com/'])
    assert.equal(validateApprovalUrl(url), null);
});

test('capture verification requires correct customer-independent test id and exact USD $1', () => {
  const response = { status: 'COMPLETED', purchase_units: [{ custom_id: demoId,
    payments: { captures: [{ id: '2F416870YW312624B', status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '1.00' } }] } }] };
  assert.equal(isCompletedCapture(response, demoId), '2F416870YW312624B');
  assert.equal(isCompletedCapture(response, 'other'), null);
  assert.equal(isCompletedCapture({ ...response, status: 'APPROVED' }, demoId), null);
  assert.equal(isCompletedCapture({ ...response, purchase_units: [{ ...response.purchase_units[0],
    payments: { captures: [{ ...response.purchase_units[0].payments.captures[0],
      amount: { currency_code: 'USD', value: '101.00' } }] } }] }, demoId), null);
});

test('GET config returns no secrets and no live selling', async () => {
  const res = await worker.fetch(new Request(origin + '/api/paypal/sandbox/config'), env());
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.liveCheckoutEnabled, false);
  assert.equal(body.cjFulfillmentEnabled, false);
  assert.equal(body.testAmountUsd, '1.00');
  for (const secret of ['hidden-secret', 'LIVE_SECRET', 'CJ_SECRET']) assert.ok(!text.includes(secret));
});

test('POST create requires same origin and JSON', async () => {
  const e = env();
  assert.equal((await worker.fetch(new Request(origin + '/api/paypal/sandbox/create',
    { method: 'POST', headers: { Origin: 'https://evil.com', 'Content-Type': 'application/json' }, body: '{}' }), e)).status, 403);
  assert.equal((await worker.fetch(new Request(origin + '/api/paypal/sandbox/create',
    { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: '{}' }), e)).status, 415);
  assert.equal(e.DB.state.accesses.length, 0);
});

test('create and capture via PayPal sandbox; fixed authoritative amount and idempotent duplicate', async () => {
  const e = env();
  const old = globalThis.fetch;
  let createdId, createdRequestId, capturedRequestId, apiCalls = 0;
  globalThis.fetch = async (url, init) => {
    assert.ok(url.startsWith('https://api-m.sandbox.paypal.com/'));
    assert.ok(!JSON.stringify(init).includes('LIVE_SECRET_MUST_NEVER_BE_USED'));
    assert.ok(!JSON.stringify(init).includes('CJ_SECRET_MUST_NEVER_BE_USED'));
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'sandbox-access-token' });
    if (url.endsWith('/v2/checkout/orders')) {
      apiCalls++;
      const body = JSON.parse(init.body);
      createdId = body.purchase_units[0].custom_id;
      assert.equal(body.purchase_units[0].amount.value, '1.00');
      assert.equal(body.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING');
      createdRequestId = init.headers['PayPal-Request-Id'];
      return Response.json({ id: paypalId, links: [{ rel: 'payer-action',
        href: 'https://www.sandbox.paypal.com/checkoutnow?token=' + paypalId }] });
    }
    if (url.endsWith('/capture')) {
      apiCalls++;
      capturedRequestId = init.headers['PayPal-Request-Id'];
      return Response.json({ id: paypalId, status: 'COMPLETED', purchase_units: [{ custom_id: createdId,
        payments: { captures: [{ id: '2F416870YW312624B', status: 'COMPLETED',
          amount: { value: '1.00', currency_code: 'USD' } }] } }] });
    }
    throw new Error('Unexpected fetch call: ' + url);
  };
  try {
    const create = await worker.fetch(post('/api/paypal/sandbox/create', { price: 1_000_000, sku: 'other' }), e);
    assert.equal(create.status, 201);
    assert.equal(createdRequestId, createdId + '-create');
    const start = await create.json();
    assert.equal(start.environment, 'sandbox');
    assert.equal(e.DB.state.rows.get(start.checkoutId).amount_cents, 100);
    const capture = await worker.fetch(post('/api/paypal/sandbox/capture', { checkoutId: start.checkoutId }), e);
    assert.equal(capture.status, 200);
    assert.equal((await capture.json()).status, 'paid');
    assert.equal(capturedRequestId, createdId + '-capture');
    const duplicate = await worker.fetch(post('/api/paypal/sandbox/capture', { checkoutId: start.checkoutId }), e);
    assert.equal(duplicate.status, 200);
    assert.equal(apiCalls, 2); // create + capture, no second capture
    const status = await worker.fetch(new Request(origin + '/api/paypal/sandbox/status?checkoutId=' + start.checkoutId), e);
    assert.equal((await status.json()).status, 'paid');
    assert.equal(e.DB.state.rows.get(start.checkoutId).paypal_capture_id, '2F416870YW312624B');
  } finally { globalThis.fetch = old; }
});

test('never exposes a working real-order or CJ payment endpoint', async () => {
  const e = env();
  for (const path of ['/api/paypal/live/create', '/api/cj/order', '/api/orders']) {
    const res = await worker.fetch(post(path), e);
    assert.equal(res.status, 404);
  }
});
