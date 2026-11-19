import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { verifiedProductCapture, productSandboxReady } from '../src/product-sandbox.js';
import { basketFingerprint, catalogRows } from '../src/cj-shipping.js';
import { ownerHash } from '../src/commerce-security.js';
import { pricingPolicy, priceBasket } from '../src/retail-pricing.js';
import { fixtureEnv, seed, request, cjMock, origin } from './helpers/d1.mjs';

const base = '/api/paypal/product-sandbox/';
const paypalId = 'MOCKPAYPALORDER01',
  captureId = 'MOCKCAPTUREID001';
async function quoteFixture(env) {
  const item = await seed(env),
    owner = await ownerHash(request('/')),
    p = pricingPolicy(env);
  const rows = await catalogRows(env.DB, [item]),
    id = crypto.randomUUID();
  const snapshot = {
    items: [item],
    zip: '10001',
    lines: [
      {
        variantId: item.variantId,
        productId: 'TEST-P1',
        quantity: 1,
        title: 'Automated fixture only',
        unitPriceCents: 2500,
        supplierCostCents: 1000,
        origin: 'US'
      }
    ],
    shipments: [
      {
        carrier: 'Mock USPS',
        freightCents: 471,
        origin: 'US',
        variantIds: [item.variantId]
      }
    ]
  };
  const prices = priceBasket(snapshot.lines, 471, p);
  await env.DB.prepare(
    `INSERT INTO commerce_quotes(id,owner_hash,fingerprint,policy_json,destination_zip,snapshot_json,
    subtotal_cents,shipping_cents,total_cents,created_ms,expires_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      id,
      owner,
      await basketFingerprint(rows, p, '10001'),
      JSON.stringify(p),
      '10001',
      JSON.stringify(snapshot),
      prices.subtotalCents,
      prices.shippingCents,
      prices.totalCents,
      Date.now(),
      Date.now() + 600000
    )
    .run();
  return { quoteId: id, requestKey: crypto.randomUUID() };
}
function paypalMock({ lostCapture = false, mismatch = false, lostCreate = false } = {}) {
  const state = {
    creates: 0,
    captures: 0,
    gets: 0,
    createKeys: [],
    captureKeys: [],
    unit: null,
    paid: false
  };
  const fetch = async (raw, init) => {
    const url = new URL(raw);
    if (url.hostname === 'developers.cjdropshipping.com') return cjMock()(raw, init);
    assert.equal(url.hostname, 'api-m.sandbox.paypal.com');
    assert.ok(!JSON.stringify(init).includes('LIVE-SECRET'));
    if (url.pathname === '/v1/oauth2/token')
      return Response.json({ access_token: 'MOCK-PAYPAL-ACCESS' });
    if (url.pathname === '/v2/checkout/orders') {
      state.creates++;
      state.createKeys.push(init.headers['PayPal-Request-Id']);
      state.unit = JSON.parse(init.body).purchase_units[0];
      assert.equal(state.unit.amount.value, '35.83');
      assert.equal(state.unit.items[0].quantity, '1');
      assert.equal(state.unit.items[0].unit_amount.value, '25.00');
      assert.ok(state.unit.items[0].name.startsWith('Sandbox: '));
      assert.equal(
        JSON.parse(init.body).payment_source.paypal.experience_context.shipping_preference,
        'NO_SHIPPING'
      );
      if (lostCreate && state.creates === 1) throw new Error('Lost create response');
      return Response.json({
        id: paypalId,
        status: 'CREATED',
        purchase_units: [state.unit],
        links: [
          {
            rel: 'payer-action',
            href: 'https://www.sandbox.paypal.com/checkoutnow?token=' + paypalId
          }
        ]
      });
    }
    function representation(status) {
      return {
        id: paypalId,
        status,
        purchase_units: [
          {
            ...state.unit,
            ...(status === 'COMPLETED'
              ? {
                  payments: {
                    captures: [
                      {
                        id: captureId,
                        status: 'COMPLETED',
                        final_capture: true,
                        amount: {
                          value: mismatch ? '1.00' : state.unit.amount.value,
                          currency_code: 'USD'
                        }
                      }
                    ]
                  }
                }
              : {})
          }
        ]
      };
    }
    if (url.pathname.endsWith('/capture')) {
      state.captures++;
      state.captureKeys.push(init.headers['PayPal-Request-Id']);
      state.paid = true;
      if (lostCapture) throw new Error('Ambiguous response PRIVATE payer details');
      return Response.json(representation('COMPLETED'));
    }
    assert.equal(init.method, 'GET');
    state.gets++;
    return Response.json(representation(state.paid ? 'COMPLETED' : 'APPROVED'));
  };
  return { state, fetch };
}
test('product capture verifies exact order, reference, custom id, currency, amount and one completed capture', () => {
  const row = {
    id: crypto.randomUUID(),
    paypal_order_id: paypalId,
    total_cents: 3583
  };
  const data = {
    id: paypalId,
    status: 'COMPLETED',
    purchase_units: [
      {
        reference_id: row.id,
        custom_id: row.id,
        amount: { currency_code: 'USD', value: '35.83' },
        payments: {
          captures: [
            {
              id: captureId,
              status: 'COMPLETED',
              final_capture: true,
              amount: { currency_code: 'USD', value: '35.83' }
            }
          ]
        }
      }
    ]
  };
  assert.equal(verifiedProductCapture(data, row).id, captureId);
  const changes = [
    (d) => (d.id = 'OTHERORDER'),
    (d) => (d.status = 'APPROVED'),
    (d) => (d.purchase_units[0].custom_id = 'OTHER'),
    (d) => (d.purchase_units[0].reference_id = 'OTHER'),
    (d) => (d.purchase_units[0].amount.value = '1.00'),
    (d) => (d.purchase_units[0].payments.captures[0].amount.currency_code = 'PHP'),
    (d) => (d.purchase_units[0].payments.captures[0].amount.value = '35.830'),
    (d) => (d.purchase_units[0].payments.captures[0].status = 'PENDING'),
    (d) => (d.purchase_units[0].payments.captures[0].final_capture = false),
    (d) => d.purchase_units.push(d.purchase_units[0]),
    (d) => d.purchase_units[0].payments.captures.push(d.purchase_units[0].payments.captures[0])
  ];
  for (const change of changes) {
    const bad = structuredClone(data);
    change(bad);
    assert.equal(verifiedProductCapture(bad, row), null);
  }
});
test('product Sandbox requires local host, explicit flag, Sandbox mode and credentials', async () => {
  const env = fixtureEnv();
  assert.equal(productSandboxReady(request(base + 'config'), env), true);
  for (const patched of [
    { PAYPAL_MODE: 'live' },
    { PRODUCT_SANDBOX_CHECKOUT_ENABLED: 'false' },
    { PAYPAL_SANDBOX_CLIENT_SECRET: '' }
  ])
    assert.equal(productSandboxReady(request(base + 'config'), { ...env, ...patched }), false);
  for (const source of ['https://thesoftnestedit.online', 'https://localhost.evil.test']) {
    assert.equal((await worker.fetch(request(base + 'create', {}, { source }), env)).status, 503);
  }
  const config = await worker.fetch(request(base + 'config'), env);
  assert.ok(!(await config.text()).includes('MOCK-SANDBOX'));
});
test('product Sandbox validates same origin, owner session and request sizes', async () => {
  const env = fixtureEnv();
  for (const [req, status] of [
    [request(base + 'create', {}, { headers: { Origin: 'https://evil.test' } }), 403],
    [request(base + 'create', {}, { cookieValue: '' }), 401],
    [request(base + 'create', { padding: 'x'.repeat(6000) }), 413],
    [request(base + 'create', {}), 400],
    [request(base + 'capture', { checkoutId: 'bad' }), 400]
  ])
    assert.equal((await worker.fetch(req, env)).status, status);
});
test('server-priced product Sandbox persists exact selections and quote; duplicate create and capture are idempotent', async () => {
  const env = fixtureEnv(),
    payload = await quoteFixture(env),
    mock = paypalMock(),
    old = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  try {
    const create = await worker.fetch(
      request(base + 'create', { ...payload, totalCents: 1, price: 1 }),
      env
    );
    assert.equal(create.status, 201);
    const checkout = await create.json();
    const duplicate = await worker.fetch(request(base + 'create', payload), env);
    assert.equal(duplicate.status, 200);
    assert.equal(mock.state.creates, 1);
    const foreign = await worker.fetch(
      request(base + 'status?checkoutId=' + checkout.checkoutId, undefined, {
        cookieValue: 'softnest-commerce=' + 'b'.repeat(64)
      }),
      env
    );
    assert.equal(foreign.status, 404);
    const collision = await worker.fetch(
      request(base + 'create', { ...payload, requestKey: crypto.randomUUID() }),
      env
    );
    assert.equal(collision.status, 409);
    const [a, b] = await Promise.all([
      worker.fetch(request(base + 'capture', { checkoutId: checkout.checkoutId }), env),
      worker.fetch(request(base + 'capture', { checkoutId: checkout.checkoutId }), env)
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(mock.state.captures, 1);
    const again = await worker.fetch(
      request(base + 'capture', { checkoutId: checkout.checkoutId }),
      env
    );
    assert.equal(again.status, 200);
    assert.equal(mock.state.captures, 1);
    const row = await env.DB.prepare('SELECT * FROM product_sandbox_orders WHERE id=?')
      .bind(checkout.checkoutId)
      .first();
    assert.equal(row.total_cents, 3583);
    assert.equal(row.status, 'paid');
    assert.equal(row.paypal_capture_id, captureId);
    assert.equal(JSON.parse(row.snapshot_json).lines[0].variantId, 'TEST-V1');
    assert.equal(JSON.parse(row.capture_json).amountCents, 3583);
    assert.equal(mock.state.captureKeys[0], checkout.checkoutId + '-capture');
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first()).n, 0);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM fulfillment_jobs').first()).n, 0);
    assert.ok(!JSON.stringify(checkout).includes('supplierCost'));
    assert.ok(!JSON.stringify(checkout).includes('owner_hash'));
    await assert.rejects(
      env.DB.prepare(
        `INSERT INTO sandbox_checkouts(id,status,amount_cents,currency) VALUES('bad','creating',3583,'USD')`
      ).run()
    );
  } finally {
    globalThis.fetch = old;
  }
});
test('lost capture response reconciles PayPal completion without a second capture or a new payment', async () => {
  const env = fixtureEnv(),
    payload = await quoteFixture(env),
    mock = paypalMock({ lostCapture: true }),
    old = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  try {
    const checkout = await (await worker.fetch(request(base + 'create', payload), env)).json();
    const first = await worker.fetch(
      request(base + 'capture', { checkoutId: checkout.checkoutId }),
      env
    );
    assert.equal(first.status, 502);
    assert.ok(!(await first.text()).includes('PRIVATE'));
    assert.equal(mock.state.captures, 1);
    assert.equal(
      (await worker.fetch(request(base + 'capture', { checkoutId: checkout.checkoutId }), env))
        .status,
      409
    );
    // Simulate elapsed lease and quote expiration. Already-paid captures must still reconcile.
    await env.DB.prepare('UPDATE product_sandbox_orders SET lease_until_ms=0').run();
    await env.DB.prepare('UPDATE commerce_quotes SET created_ms=?,expires_ms=?')
      .bind(Date.now() - 10000, Date.now() - 1)
      .run();
    const retry = await worker.fetch(
      request(base + 'capture', { checkoutId: checkout.checkoutId }),
      env
    );
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).status, 'paid');
    assert.equal(mock.state.captures, 1);
  } finally {
    globalThis.fetch = old;
  }
});
test('lost create response retries the exact stored snapshot and PayPal idempotency key', async () => {
  const env = fixtureEnv(),
    payload = await quoteFixture(env),
    mock = paypalMock({ lostCreate: true }),
    old = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  try {
    assert.equal((await worker.fetch(request(base + 'create', payload), env)).status, 502);
    await env.DB.prepare('UPDATE product_sandbox_orders SET lease_until_ms=0').run();
    assert.equal((await worker.fetch(request(base + 'create', payload), env)).status, 201);
    assert.equal(mock.state.createKeys.length, 2);
    assert.equal(mock.state.createKeys[0], mock.state.createKeys[1]);
    assert.equal(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM product_sandbox_orders').first()).n,
      1
    );
  } finally {
    globalThis.fetch = old;
  }
});
test('wrong capture amount enters manual review and cannot be retried', async () => {
  const env = fixtureEnv(),
    payload = await quoteFixture(env),
    mock = paypalMock({ mismatch: true }),
    old = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  try {
    const checkout = await (await worker.fetch(request(base + 'create', payload), env)).json();
    assert.equal(
      (await worker.fetch(request(base + 'capture', { checkoutId: checkout.checkoutId }), env))
        .status,
      409
    );
    const row = await env.DB.prepare('SELECT status FROM product_sandbox_orders WHERE id=?')
      .bind(checkout.checkoutId)
      .first();
    assert.equal(row.status, 'needs_review');
    assert.equal(
      (await worker.fetch(request(base + 'capture', { checkoutId: checkout.checkoutId }), env))
        .status,
      409
    );
    assert.equal(mock.state.captures, 1);
  } finally {
    globalThis.fetch = old;
  }
});
test('expired quote and revoked approval cannot start a Sandbox order', async () => {
  const env = fixtureEnv(),
    payload = await quoteFixture(env),
    old = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('No PayPal or CJ calls allowed');
  };
  try {
    await env.DB.prepare('UPDATE cj_variants SET active=0').run();
    assert.equal((await worker.fetch(request(base + 'create', payload), env)).status, 409);
    await env.DB.prepare('UPDATE cj_variants SET active=1').run();
    await env.DB.prepare('UPDATE commerce_quotes SET created_ms=?,expires_ms=?')
      .bind(Date.now() - 10000, Date.now() - 1)
      .run();
    assert.equal((await worker.fetch(request(base + 'create', payload), env)).status, 409);
    assert.equal(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM product_sandbox_orders').first()).n,
      0
    );
  } finally {
    globalThis.fetch = old;
  }
});

test('revoked approval after PayPal creation blocks a new capture without supplier work', async () => {
  const env = fixtureEnv(),
    payload = await quoteFixture(env),
    mock = paypalMock(),
    old = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  try {
    const checkout = await (await worker.fetch(request(base + 'create', payload), env)).json();
    await env.DB.prepare('UPDATE cj_variants SET active=0').run();
    assert.equal(
      (await worker.fetch(request(base + 'capture', { checkoutId: checkout.checkoutId }), env))
        .status,
      409
    );
    assert.equal(mock.state.captures, 0);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first()).n, 0);
  } finally {
    globalThis.fetch = old;
  }
});

test('an uncompleted order outside the PayPal idempotency window requires manual review', async () => {
  const env = fixtureEnv(),
    payload = await quoteFixture(env),
    mock = paypalMock(),
    old = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  try {
    const checkout = await (await worker.fetch(request(base + 'create', payload), env)).json();
    await env.DB.prepare('UPDATE product_sandbox_orders SET created_ms=?')
      .bind(Date.now() - 6 * 60 * 60 * 1000 - 1)
      .run();
    assert.equal(
      (await worker.fetch(request(base + 'capture', { checkoutId: checkout.checkoutId }), env))
        .status,
      409
    );
    assert.equal(
      (await env.DB.prepare('SELECT status FROM product_sandbox_orders').first()).status,
      'needs_review'
    );
    assert.equal(mock.state.captures, 0);
  } finally {
    globalThis.fetch = old;
  }
});
