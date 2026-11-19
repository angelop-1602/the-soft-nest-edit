import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import {
  authEnv,
  externalMock,
  call,
  pending,
  reviewed,
  versions,
  decision,
  qualityReview,
  variantReview,
  adminRequest
} from './helpers/admin.mjs';
import { request, seed } from './helpers/d1.mjs';
import { cartView, quoteShipping } from '../src/cj-shipping.js';
import { loadPricingPolicy } from '../src/retail-pricing.js';
import { shippingFingerprint } from '../src/admin-products-data.js';
import { ownerHash } from '../src/commerce-security.js';

test('administrator can review, verify, price and approve one exact variant; only retail values reach the public cart', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  globalThis.fetch = externalMock();
  try {
    let d = await reviewed(env);
    assert.deepEqual(d.variants[0].approvalIssues, []);
    let cart = await cartView(env, [{ variantId: 'TEST-V1', quantity: 1 }]);
    assert.equal(cart.lines[0].unitPriceCents, null);
    d = await call(env, 'products/TEST-P1/decision', decision(d));
    assert.equal(d.product.status, 'approved');
    assert.equal(d.variants[0].status, 'approved');
    assert.equal(d.variants[0].active, true);
    cart = await cartView(env, [{ variantId: 'TEST-V1', quantity: 1 }]);
    assert.equal(cart.lines[0].unitPriceCents, 2500);
    for (const word of ['supplierCost', 'costCents', 'MOCK-CJ', 'pricingException', 'actor_sub'])
      assert.ok(!JSON.stringify(cart).includes(word));
    const quote = await quoteShipping(
      env,
      'test-owner',
      [{ variantId: 'TEST-V1', quantity: 1 }],
      '10001'
    );
    assert.ok(quote.totalCents > 2500);
    const audits = (
      await env.DB.prepare(
        "SELECT * FROM admin_audit WHERE action='retail_price_changed' AND variant_id IS NOT NULL"
      ).all()
    ).results;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_email, 'owner@example.test');
    assert.equal(JSON.parse(audits[0].after_json).priceCents, 2500);
    await assert.rejects(env.DB.prepare("UPDATE admin_audit SET reason='tampered'").run());
    const blocked = await worker.fetch(
      request('/api/admin/products/TEST-P1/decision', decision(d)),
      env
    );
    assert.equal(blocked.status, 401);
    assert.equal((await env.DB.prepare('SELECT active FROM cj_variants').first()).active, 1);
  } finally {
    globalThis.fetch = old;
  }
});
test('approval cannot bypass missing quality, stock, pricing, shipping or expired verification', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  globalThis.fetch = externalMock();
  try {
    let d = await pending(env);
    await assert.rejects(
      call(env, 'products/TEST-P1/decision', decision(d)),
      (e) => e.code === 'approval_blocked'
    );
    // Public writes cannot set internal flags or verification timestamps.
    const malicious = await worker.fetch(
      request('/api/commerce/cart', {
        items: [{ variantId: 'TEST-V1', quantity: 1 }],
        active: 1,
        retail_price_cents: 1,
        inventory_verified_at: new Date().toISOString()
      }),
      env
    );
    assert.equal(malicious.status, 200);
    assert.equal((await malicious.json()).lines[0].unitPriceCents, null);
    const fresh = authEnv();
    d = await reviewed(fresh);
    await fresh.DB.prepare('UPDATE admin_shipping_checks SET expires_ms=checked_ms+1').run();
    await assert.rejects(
      call(fresh, 'products/TEST-P1/decision', decision(d)),
      (e) => e.code === 'approval_blocked'
    );
    await fresh.DB.prepare('UPDATE cj_variants SET inventory_verified_at=NULL').run();
    d = await call(fresh, 'products/TEST-P1');
    await assert.rejects(
      call(fresh, 'products/TEST-P1/decision', decision(d)),
      (e) => e.code === 'approval_blocked'
    );
  } finally {
    globalThis.fetch = old;
  }
});
test('QA fixture flag is permanent and sale-ineligible even through direct privileged state changes', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  globalThis.fetch = externalMock();
  try {
    let d = await pending(env, { pid: 'QA-PENDING-P1', vid: 'QA-V1' });
    await env.DB.prepare(
      "UPDATE cj_products SET fixture_only=1,active=0,review_state='disabled' WHERE cj_product_id='QA-PENDING-P1'"
    ).run();
    await env.DB.prepare("UPDATE cj_variants SET fixture_only=1 WHERE cj_variant_id='QA-V1'").run();
    d = await call(env, 'products/QA-PENDING-P1');
    await assert.rejects(
      call(env, 'products/QA-PENDING-P1/decision', decision(d)),
      (e) => e.code === 'approval_blocked'
    );
    await assert.rejects(env.DB.prepare('UPDATE cj_products SET fixture_only=0').run());
    await assert.rejects(env.DB.prepare('UPDATE cj_variants SET fixture_only=0').run());
    await assert.rejects(
      env.DB.prepare("UPDATE cj_variants SET active=1,review_state='approved'").run()
    );
    await assert.rejects(
      env.DB.prepare("UPDATE cj_products SET active=1,review_state='approved'").run()
    );
    assert.equal(
      (await cartView(env, [{ variantId: 'QA-V1', quantity: 1 }])).lines[0].reason,
      'fixture_not_for_sale'
    );
  } finally {
    globalThis.fetch = old;
  }
});
test('stale and concurrent price edits cannot overwrite a newer decision; shipping invalidation is destination specific', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  globalThis.fetch = externalMock();
  try {
    let d = await reviewed(env, { approve: true });
    const original = versions(d);
    d = await call(env, 'products/TEST-P1/variants/TEST-V1/price', {
      ...original,
      retailPriceUsd: '26.00'
    });
    await assert.rejects(
      call(env, 'products/TEST-P1/variants/TEST-V1/price', { ...original, retailPriceUsd: '1.00' }),
      (e) => ['edit_conflict', 'margin_below_policy'].includes(e.code)
    );
    assert.equal(
      (await env.DB.prepare('SELECT retail_price_cents FROM cj_variants').first())
        .retail_price_cents,
      2600
    );
    const payload = { ...versions(d), retailPriceUsd: '27.00' };
    const results = await Promise.allSettled([
      call(env, 'products/TEST-P1/variants/TEST-V1/price', payload),
      call(env, 'products/TEST-P1/variants/TEST-V1/price', { ...payload, retailPriceUsd: '28.00' })
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'edit_conflict');
    d = await call(env, 'products/TEST-P1');
    d = await call(env, 'products/TEST-P1/decision', decision(d));
    globalThis.fetch = async (raw, init) =>
      new URL(raw).pathname.endsWith('/freightCalculate')
        ? Response.json({ code: 200, result: true, data: [] })
        : externalMock()(raw, init);
    d = await call(env, 'products/TEST-P1/variants/TEST-V1/shipping', {
      ...versions(d),
      zip: '99999',
      quantity: 1
    });
    assert.equal(d.verification.status, 'unavailable');
    assert.equal(d.variants[0].active, true);
    assert.ok(
      d.variants[0].shippingChecks.some((c) => c.zip === '10001' && c.status === 'available')
    );
    assert.ok(
      d.variants[0].shippingChecks.some((c) => c.zip === '99999' && c.status === 'unavailable')
    );
  } finally {
    globalThis.fetch = old;
  }
});
test('disable, reject, cost changes, specification changes and lost supplier verification block new checkout attempts', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  globalThis.fetch = externalMock();
  try {
    let d = await reviewed(env, { approve: true });
    d = await call(env, 'products/TEST-P1/decision', decision(d, 'disable'));
    assert.equal(d.variants[0].active, false);
    assert.equal(
      (await cartView(env, [{ variantId: 'TEST-V1', quantity: 1 }])).subtotalCents,
      null
    );
    await assert.rejects(
      quoteShipping(env, 'owner', [{ variantId: 'TEST-V1', quantity: 1 }], '10001')
    );
    d = await call(env, 'products/TEST-P1/decision', decision(d, 'reject', 'product'));
    assert.equal(d.product.status, 'rejected');
    const approved = authEnv();
    d = await reviewed(approved, { approve: true });
    await approved.DB.prepare('UPDATE cj_variants SET supplier_cost_cents=1100').run();
    let row = await approved.DB.prepare(
      'SELECT active,retail_verified_at,approved_review_version FROM cj_variants'
    ).first();
    assert.equal(row.active, 0);
    assert.equal(row.retail_verified_at, null);
    assert.equal(row.approved_review_version, null);
    const specs = authEnv();
    d = await reviewed(specs, { approve: true });
    await specs.DB.prepare(
      "UPDATE cj_products SET title='Updated supplier size and specification'"
    ).run();
    assert.equal((await specs.DB.prepare('SELECT active FROM cj_variants').first()).active, 0);
    assert.equal(
      (await specs.DB.prepare('SELECT review_json FROM cj_products').first()).review_json,
      '{}'
    );
    const unavailable = authEnv();
    d = await reviewed(unavailable, { approve: true });
    globalThis.fetch = async (raw, init) =>
      new URL(raw).pathname.endsWith('/queryByVid')
        ? new Response('private token failure', { status: 503 })
        : externalMock()(raw, init);
    d = await call(unavailable, 'products/TEST-P1/variants/TEST-V1/verify', {
      ...versions(d),
      origin: 'US'
    });
    assert.equal(d.verification.status, 'error');
    assert.equal(d.variants[0].stockVerified, false);
    assert.equal(d.variants[0].active, false);
    assert.ok(!JSON.stringify(d).includes('private token failure'));
  } finally {
    globalThis.fetch = old;
  }
});
test('global markup/margin policy is versioned and audited; bounded price exceptions require explicit acknowledgement', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  globalThis.fetch = externalMock();
  try {
    let d = await reviewed(env, { approve: true });
    let state = (await call(env, 'session')).policy;
    const policy = {
      ...state.policy,
      markupBps: 1000,
      allowMarginExceptions: true,
      exceptionMinimumMarginBps: 1000,
      exceptionMaxHours: 24
    };
    await call(env, 'policy', {
      expectedRevision: state.revision,
      policy,
      reason: 'Allow a limited documented promotional test with a minimum margin floor.'
    });
    state = (await call(env, 'session')).policy;
    assert.equal(state.revision, 1);
    assert.equal(state.policy.markupBps, 1000);
    assert.equal(
      (await cartView(env, [{ variantId: 'TEST-V1', quantity: 1 }])).subtotalCents,
      null
    );
    d = await call(env, 'products/TEST-P1');
    const payload = { ...versions(d), retailPriceUsd: '16.00' };
    await assert.rejects(
      call(env, 'products/TEST-P1/variants/TEST-V1/price', payload),
      (e) => e.code === 'margin_below_policy'
    );
    await assert.rejects(
      call(env, 'products/TEST-P1/variants/TEST-V1/price', {
        ...payload,
        exception: {
          acknowledged: false,
          minimumMarginBps: 1000,
          hours: 1,
          reason: 'Reviewed promotion with deliberately reduced net margin.'
        }
      })
    );
    d = await call(env, 'products/TEST-P1/variants/TEST-V1/price', {
      ...payload,
      exception: {
        acknowledged: true,
        minimumMarginBps: 1000,
        hours: 1,
        reason: 'Reviewed promotion with deliberately reduced net margin.'
      }
    });
    assert.ok(d.variants[0].pricingException.id);
    d = await call(env, 'products/TEST-P1/decision', decision(d));
    assert.equal(d.variants[0].active, true);
    assert.equal(
      (await cartView(env, [{ variantId: 'TEST-V1', quantity: 1 }])).lines[0].unitPriceCents,
      1600
    );
    const quote = await quoteShipping(
      env,
      'exception-owner',
      [{ variantId: 'TEST-V1', quantity: 1 }],
      '10001'
    );
    assert.ok(quote.totalCents > 1600);
    assert.equal(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM admin_audit WHERE action='price_exception_acknowledged' AND variant_id IS NOT NULL"
        ).first()
      ).n,
      1
    );
    const row = await env.DB.prepare('SELECT pricing_exception_json FROM cj_variants').first();
    const ex = JSON.parse(row.pricing_exception_json);
    ex.expiresMs = Date.now() - 1;
    await env.DB.prepare('UPDATE cj_variants SET pricing_exception_json=?')
      .bind(JSON.stringify(ex))
      .run();
    assert.equal(
      (await cartView(env, [{ variantId: 'TEST-V1', quantity: 1 }])).lines[0].unitPriceCents,
      null
    );
    await assert.rejects(
      call(env, 'policy', {
        expectedRevision: 0,
        policy,
        reason: 'This is an intentionally stale policy update.'
      }),
      (e) => e.code === 'edit_conflict'
    );
    assert.equal((await loadPricingPolicy(env)).version, state.policy.version);
  } finally {
    globalThis.fetch = old;
  }
});
test('search, filters and pagination are bounded and do not interpret wildcards or SQL input', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  globalThis.fetch = externalMock();
  try {
    await pending(env);
    await env.DB.prepare("UPDATE cj_products SET title='Linen_100% Cushion'").run();
    const one = await call(env, 'products?q=' + encodeURIComponent('Linen_100%'));
    assert.equal(one.total, 1);
    const none = await call(env, 'products?q=' + encodeURIComponent("' OR 1=1 --"));
    assert.equal(none.total, 0);
    assert.equal((await call(env, 'products?filter=missing_pricing')).total, 0);
    assert.equal((await call(env, 'products?filter=shipping_unavailable')).total, 1);
    for (const query of ['page=0', 'page=-1', 'filter=drop_table', 'q=' + 'x'.repeat(101)])
      await assert.rejects(call(env, 'products?' + query), (e) => e.status === 400);
    for (let i = 0; i < 14; i++) await seed(env, { pid: 'P-' + i, vid: 'V-' + i, active: 0 });
    assert.equal((await call(env, 'products?page=1')).products.length, 12);
    assert.equal((await call(env, 'products?page=2')).products.length, 3);
  } finally {
    globalThis.fetch = old;
  }
});

test('a newer failed check supersedes an older successful quote for the same destination', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  globalThis.fetch = externalMock();
  try {
    let d = await reviewed(env);
    globalThis.fetch = async (raw, init) =>
      new URL(raw).pathname.endsWith('/freightCalculate')
        ? Response.json({ code: 200, result: true, data: [] })
        : externalMock()(raw, init);
    d = await call(env, 'products/TEST-P1/variants/TEST-V1/shipping', {
      ...versions(d),
      zip: '10001',
      quantity: 1
    });
    assert.equal(d.variants[0].shippingChecks.find((c) => c.status === 'available').current, false);
    await assert.rejects(
      call(env, 'products/TEST-P1/decision', decision(d)),
      (e) => e.code === 'approval_blocked'
    );
  } finally {
    globalThis.fetch = old;
  }
});

test('bulk approval of 100 reviewed variants uses bounded statements and bindings with individual audit records', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  globalThis.fetch = externalMock();
  try {
    await reviewed(env);
    for (let i = 2; i <= 100; i++) {
      const vid = 'BULK-' + i;
      await env.DB.prepare(
        `INSERT INTO cj_variants(id,product_id,cj_variant_id,cj_sku,options_json,supplier_cost_cents,
        retail_price_cents,inventory_quantity,supplier_cost_verified_at,retail_verified_at,inventory_verified_at,origin_country_code,
        approved_supplier_cost_cents,retail_policy_version,review_json)
        SELECT ?,product_id,?,cj_sku,options_json,supplier_cost_cents,retail_price_cents,inventory_quantity,supplier_cost_verified_at,
          retail_verified_at,inventory_verified_at,origin_country_code,approved_supplier_cost_cents,retail_policy_version,review_json
        FROM cj_variants WHERE cj_variant_id='TEST-V1'`
      )
        .bind('cj-variant:' + vid, vid)
        .run();
      const p = await env.DB.prepare('SELECT * FROM cj_products').first(),
        v = await env.DB.prepare('SELECT * FROM cj_variants WHERE cj_variant_id=?')
          .bind(vid)
          .first();
      await env.DB.prepare(
        `INSERT INTO admin_shipping_checks(id,variant_id,origin,destination_zip,quantity,status,methods_json,fingerprint,checked_ms,expires_ms,actor_sub)
        VALUES(?,?,'US','10001',1,'available',?,?,?,?,'test-owner-001')`
      )
        .bind(
          crypto.randomUUID(),
          v.id,
          '[{"carrier":"Isolated mock","freightCents":471}]',
          await shippingFingerprint(p, v),
          Date.now(),
          Date.now() + 600000
        )
        .run();
    }
    let d = await call(env, 'products/TEST-P1');
    assert.equal(d.variants.length, 100);
    const original = env.DB.prepare;
    let prepared = 0;
    env.DB.prepare = (...args) => {
      prepared++;
      return original(...args);
    };
    d = await call(env, 'products/TEST-P1/decision', decision(d, 'approve', 'product'));
    assert.ok(prepared < 25, 'Bulk action and detail should fit free-plan query limits');
    assert.ok(d.variants.every((v) => v.active));
    assert.equal(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM admin_audit WHERE action='product_approved' AND variant_id IS NOT NULL"
        ).first()
      ).n,
      100
    );
  } finally {
    globalThis.fetch = old;
  }
});

test('an administrator suspension blocks both a new and previously-created product Sandbox checkout', async () => {
  const env = authEnv(),
    old = globalThis.fetch;
  let creates = 0,
    captures = 0,
    unit;
  globalThis.fetch = async (raw, init) => {
    const url = new URL(raw);
    if (url.hostname !== 'api-m.sandbox.paypal.com') return externalMock()(raw, init);
    if (url.pathname.endsWith('/oauth2/token'))
      return Response.json({ access_token: 'MOCK-SANDBOX-ACCESS' });
    if (url.pathname === '/v2/checkout/orders') {
      creates++;
      unit = JSON.parse(init.body).purchase_units[0];
      return Response.json({
        id: 'MOCKORDERID001',
        purchase_units: [unit],
        links: [
          {
            rel: 'approve',
            href: 'https://www.sandbox.paypal.com/checkoutnow?token=MOCKORDERID001'
          }
        ]
      });
    }
    if (url.pathname.endsWith('/capture')) {
      captures++;
      throw new Error('A suspended product must not be captured');
    }
    return Response.json({ id: 'MOCKORDERID001', status: 'APPROVED', purchase_units: [unit] });
  };
  try {
    let d = await reviewed(env, { approve: true });
    const quote = await quoteShipping(
      env,
      await ownerHash(request('/')),
      [{ variantId: 'TEST-V1', quantity: 1 }],
      '10001'
    );
    const payload = { quoteId: quote.quoteId, requestKey: crypto.randomUUID() };
    const created = await worker.fetch(request('/api/paypal/product-sandbox/create', payload), env);
    assert.equal(created.status, 201);
    const checkout = await created.json();
    d = await call(env, 'products/TEST-P1/decision', decision(d, 'disable'));
    assert.equal(
      (await worker.fetch(request('/api/paypal/product-sandbox/create', payload), env)).status,
      409
    );
    assert.equal(
      (
        await worker.fetch(
          request('/api/paypal/product-sandbox/create', {
            ...payload,
            requestKey: crypto.randomUUID()
          }),
          env
        )
      ).status,
      409
    );
    assert.equal(
      (
        await worker.fetch(
          request('/api/paypal/product-sandbox/capture', { checkoutId: checkout.checkoutId }),
          env
        )
      ).status,
      409
    );
    assert.equal(creates, 1);
    assert.equal(captures, 0);
  } finally {
    globalThis.fetch = old;
  }
});
