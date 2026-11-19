import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import {
  freightOptions,
  cartView,
  quoteShipping,
  validateQuote,
  verifyLiveLines,
  catalogRows
} from '../src/cj-shipping.js';
import { cjFetch, cjAuthorized } from '../src/cj-client.js';
import { ownerHash } from '../src/commerce-security.js';
import { fixtureEnv, seed, request, cjMock } from './helpers/d1.mjs';

test('freight parsing uses documented USD totals and rejects incomplete or inconsistent amounts', () => {
  const r = {
    logisticName: 'Test carrier',
    logisticPrice: '4.71',
    taxesFee: '1.00',
    clearanceOperationFee: '0.20'
  };
  assert.equal(freightOptions([r])[0].freightCents, 591);
  assert.equal(freightOptions([{ ...r, totalPostageFee: '6.00' }])[0].freightCents, 600);
  for (const bad of [
    { ...r, totalPostageFee: '4.71' },
    { ...r, taxesFee: 'unknown' },
    { ...r, logisticPrice: -1 },
    { ...r, logisticName: '' },
    { ...r, totalPostageFee: '1.999' }
  ])
    assert.deepEqual(freightOptions([bad]), []);
  assert.deepEqual(freightOptions({}), []);
});
test('cart hydrates current variants; unapproved, unknown and missing-cost selections fail closed', async () => {
  const env = fixtureEnv(),
    item = await seed(env, { active: 0 });
  let view = await cartView(env, [item, { variantId: 'UNKNOWN', quantity: 1 }]);
  assert.equal(view.lines[0].reason, 'not_approved');
  assert.equal(view.lines[1].reason, 'not_found');
  assert.equal(view.totalCents, null);
  assert.equal(view.lines[0].unitPriceCents, null);
  await env.DB.prepare("UPDATE cj_products SET active=1,review_state='approved'").run();
  await env.DB.prepare(
    "UPDATE cj_variants SET active=1,review_state='approved',approved_review_version=review_version,supplier_cost_verified_at=NULL"
  ).run();
  view = await cartView(env, [item]);
  assert.equal(view.lines[0].reason, 'cost_verification_required');
  const old = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Must not call CJ');
  };
  try {
    await assert.rejects(
      quoteShipping(env, 'owner', [item], '10001'),
      (e) => e.code === 'cost_verification_required'
    );
  } finally {
    globalThis.fetch = old;
  }
  assert.ok(!JSON.stringify(view).includes('supplier_cost'));
});
test('multi-product multi-variant quote uses exact quantities, verified origins, separate shipments and session cache', async () => {
  const env = fixtureEnv(),
    items = [
      await seed(env),
      await seed(env, { vid: 'TEST-V2' }),
      await seed(env, { vid: 'TEST-V3', pid: 'TEST-P2', origin: 'CN' })
    ];
  items[0].quantity = 2;
  let calls = 0;
  const bodies = [],
    old = globalThis.fetch;
  globalThis.fetch = async (raw, init) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.hostname, 'developers.cjdropshipping.com');
    assert.equal(init.headers['CJ-Access-Token'], 'MOCK-CJ-TOKEN');
    if (url.pathname.endsWith('/queryByVid')) {
      assert.equal(url.searchParams.get('features'), 'enable_inventory');
      const vid = url.searchParams.get('vid');
      return Response.json({
        code: 200,
        result: true,
        data: {
          vid,
          pid: vid === 'TEST-V3' ? 'TEST-P2' : 'TEST-P1',
          variantSellPrice: '10.00',
          inventories: [
            {
              countryCode: vid === 'TEST-V3' ? 'CN' : 'US',
              verifiedWarehouse: 1,
              cjInventory: 20
            }
          ]
        }
      });
    }
    assert.ok(url.pathname.endsWith('/freightCalculate'));
    bodies.push(JSON.parse(init.body));
    return Response.json({
      code: 200,
      result: true,
      data: [{ logisticName: 'Test carrier', logisticPrice: '4.71' }]
    });
  };
  try {
    const quote = await quoteShipping(env, 'owner', items, '10001-1234');
    assert.equal(calls, 5);
    assert.equal(quote.shipments.length, 2);
    assert.equal(quote.subtotalCents, 10000);
    assert.deepEqual(bodies[0], {
      startCountryCode: 'US',
      endCountryCode: 'US',
      zip: '10001-1234',
      products: [
        { vid: 'TEST-V1', quantity: 2 },
        { vid: 'TEST-V2', quantity: 1 }
      ]
    });
    assert.equal(bodies[1].startCountryCode, 'CN');
    assert.equal(quote.totalCents, quote.subtotalCents + quote.shippingCents);
    assert.equal(quote.customerCheckoutEnabled, false);
    for (const word of ['supplierCost', 'freightCents', 'MOCK-CJ', 'logisticPrice', 'owner_hash'])
      assert.ok(!JSON.stringify(quote).includes(word));
    const again = await quoteShipping(env, 'owner', items, '10001-1234');
    assert.equal(again.quoteId, quote.quoteId);
    assert.equal(calls, 5);
    await validateQuote(env, 'owner', quote.quoteId);
    await assert.rejects(
      validateQuote(env, 'another-owner', quote.quoteId),
      (e) => e.code === 'quote_expired'
    );
    await env.DB.prepare('UPDATE cj_variants SET retail_price_cents=3000 WHERE cj_variant_id=?')
      .bind('TEST-V1')
      .run();
    await assert.rejects(
      validateQuote(env, 'owner', quote.quoteId),
      (e) => e.code === 'quote_changed'
    );
    await env.DB.prepare('UPDATE commerce_quotes SET created_ms=?,expires_ms=?')
      .bind(Date.now() - 10000, Date.now() - 1)
      .run();
    await assert.rejects(
      validateQuote(env, 'owner', quote.quoteId),
      (e) => e.code === 'quote_expired'
    );
  } finally {
    globalThis.fetch = old;
  }
});
test('live checks reject supplier-cost changes and unverified warehouse inventory', async () => {
  const env = fixtureEnv(),
    item = await seed(env),
    rows = await catalogRows(env.DB, [item]),
    old = globalThis.fetch;
  try {
    globalThis.fetch = cjMock({ variantSellPrice: '11.00' });
    await assert.rejects(verifyLiveLines(env, rows), (e) => e.code === 'product_changed');
    globalThis.fetch = cjMock({
      inventories: [{ countryCode: 'US', verifiedWarehouse: 2, cjInventory: 200 }]
    });
    await assert.rejects(verifyLiveLines(env, rows), (e) => e.code === 'shipping_unavailable');
    globalThis.fetch = async (raw, init) =>
      new URL(raw).pathname.endsWith('/queryByVid')
        ? cjMock()(raw, init)
        : Response.json({ code: 200, result: true, data: [] });
    await assert.rejects(
      quoteShipping(env, 'owner', [item], '10001'),
      (e) => e.code === 'shipping_unavailable'
    );
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM commerce_quotes').first()).n, 0);
  } finally {
    globalThis.fetch = old;
  }
});
test('shipping API validates origin, session, ZIP, quantity, duplicates and oversized bodies before calls', async () => {
  const env = fixtureEnv(),
    item = await seed(env),
    path = '/api/commerce/shipping',
    old = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('No external calls expected');
  };
  try {
    for (const [req, status] of [
      [
        request(
          path,
          { items: [item], zip: '10001' },
          { headers: { Origin: 'https://evil.test' } }
        ),
        403
      ],
      [request(path, { items: [item], zip: '10001' }, { cookieValue: '' }), 401],
      [request(path, { items: [item], zip: 'INVALID' }), 400],
      [request(path, { items: [{ ...item, quantity: 6 }], zip: '10001' }), 400],
      [request(path, { items: [item, item], zip: '10001' }), 400],
      [
        request(path, {
          items: [item],
          zip: '10001',
          padding: 'x'.repeat(6000)
        }),
        413
      ]
    ])
      assert.equal((await worker.fetch(req, env)).status, status);
    const session = await worker.fetch(request('/api/commerce/session'), env);
    assert.ok(session.headers.get('Set-Cookie').includes('HttpOnly; SameSite=Strict'));
    assert.ok((await ownerHash(request('/'))).length === 64);
  } finally {
    globalThis.fetch = old;
  }
});
test('CJ long Retry-After and points exhaustion persist shared cooldowns without retry storms', async () => {
  const old = globalThis.fetch;
  let calls = 0;
  try {
    for (const [payload, headers, expected] of [
      [null, { 'Retry-After': '30' }, 'CJ_RATE_LIMITED'],
      [{ code: 16900500, result: false, message: 'PRIVATE diagnostics' }, {}, 'CJ_POINTS_EXHAUSTED']
    ]) {
      const env = fixtureEnv();
      globalThis.fetch = async () => {
        calls++;
        return payload
          ? Response.json(payload, { status: 429, headers })
          : new Response('', { status: 429, headers });
      };
      const start = calls;
      await assert.rejects(
        cjFetch(env, '/logistic/freightCalculate', {
          method: 'POST',
          body: {}
        }),
        (e) => e.code === expected
      );
      await assert.rejects(
        cjFetch(env, '/logistic/freightCalculate', {
          method: 'POST',
          body: {}
        }),
        (e) => e.code === 'CJ_RATE_LIMITED'
      );
      assert.equal(calls - start, 1);
    }
  } finally {
    globalThis.fetch = old;
  }
});
test('CJ revoked access token refreshes once and all supplier purchase endpoints are denied', async () => {
  const env = fixtureEnv();
  await seed(env);
  const old = globalThis.fetch;
  let calls = 0;
  await env.DB.prepare('UPDATE cj_api_session SET refresh_token=?,refresh_expires_ms=?')
    .bind('MOCK-REFRESH', Date.now() + 86400000)
    .run();
  globalThis.fetch = async (raw, init) => {
    calls++;
    if (new URL(raw).pathname.endsWith('/refreshAccessToken'))
      return Response.json({
        code: 200,
        result: true,
        data: {
          accessToken: 'NEW-MOCK-TOKEN',
          accessTokenExpiryDate: new Date(Date.now() + 86400000).toISOString()
        }
      });
    if (init.headers['CJ-Access-Token'] === 'MOCK-CJ-TOKEN')
      return Response.json({ code: 1600001, result: false });
    assert.equal(init.headers['CJ-Access-Token'], 'NEW-MOCK-TOKEN');
    return Response.json({ code: 200, result: true, data: [] });
  };
  try {
    assert.deepEqual(
      await cjAuthorized(env, '/product/variant/query', {
        search: { pid: 'TEST-P1' }
      }),
      []
    );
    assert.equal(calls, 3);
    for (const path of ['/shopping/order/createOrderV3', '/shopping/pay/payBalance'])
      await assert.rejects(
        cjFetch(env, path, { method: 'POST' }),
        (e) => e.code === 'CJ_ACTION_DISABLED'
      );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = old;
  }
});
test('CJ network and malformed responses are sanitized by the shipping API', async () => {
  const old = globalThis.fetch;
  try {
    for (const mock of [
      async () => {
        throw new Error('SECRET-TOKEN PRIVATE COST');
      },
      async () => new Response('PRIVATE', { status: 502 })
    ]) {
      const env = fixtureEnv(),
        item = await seed(env);
      globalThis.fetch = mock;
      const res = await worker.fetch(
        request('/api/commerce/shipping', { items: [item], zip: '10001' }),
        env
      );
      assert.equal(res.status, 503);
      assert.ok(!(await res.text()).includes('PRIVATE'));
    }
  } finally {
    globalThis.fetch = old;
  }
});

test('temporary CJ 429 retries once, then shared reservations space concurrent calls', async () => {
  const env = fixtureEnv(),
    old = globalThis.fetch,
    starts = [];
  let calls = 0;
  globalThis.fetch = async () => {
    starts.push(Date.now());
    calls++;
    return calls === 1
      ? Response.json(
          { code: 1600200, result: false },
          { status: 429, headers: { 'Retry-After': '1' } }
        )
      : Response.json({ code: 200, result: true, data: [] });
  };
  try {
    assert.deepEqual(
      await cjFetch(env, '/product/variant/query', { search: { pid: 'TEST-P1' } }),
      []
    );
    assert.equal(calls, 2);
    await Promise.all([
      cjFetch(env, '/product/variant/query'),
      cjFetch(env, '/product/variant/query')
    ]);
    assert.equal(calls, 4);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1300);
  } finally {
    globalThis.fetch = old;
  }
});
