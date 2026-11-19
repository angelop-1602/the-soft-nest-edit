import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncCjCatalog } from '../src/cj-sync.js';
import { fixtureEnv } from './helpers/d1.mjs';

test('shared CJ client preserves importer, inactive defaults, existing $1 records and cost-change approval invalidation', async () => {
  const env = fixtureEnv(),
    old = globalThis.fetch;
  let cost = '10.00';
  await env.DB.prepare(
    'INSERT INTO cj_api_session(id,access_token,access_expires_ms) VALUES(1,?,?)'
  )
    .bind('MOCK-TOKEN', Date.now() + 86400000)
    .run();
  await env.DB.prepare(
    `INSERT INTO sandbox_checkouts(id,status,amount_cents,currency) VALUES('existing-test','paid',100,'USD')`
  ).run();
  globalThis.fetch = async (raw, init) => {
    const url = new URL(raw);
    assert.equal(url.hostname, 'developers.cjdropshipping.com');
    assert.equal(init.method, 'GET');
    if (url.pathname.endsWith('/myProduct/query'))
      return Response.json({
        code: 200,
        result: true,
        data: {
          pageNumber: 1,
          totalPages: 1,
          totalRecords: 1,
          content: [
            {
              productId: 'IMPORT-P1',
              nameEn: 'Isolated import fixture',
              bigImage: 'https://example.test/image.jpg',
              sku: 'MOCK-SKU'
            }
          ]
        }
      });
    assert.ok(url.pathname.endsWith('/variant/query'));
    return Response.json({
      code: 200,
      result: true,
      data: [
        {
          vid: 'IMPORT-V1',
          variantSku: 'MOCK-VSKU',
          variantSellPrice: cost,
          variantKey: 'Natural'
        }
      ]
    });
  };
  try {
    assert.equal((await syncCjCatalog(env)).status, 'success');
    let row = await env.DB.prepare('SELECT * FROM cj_variants').first();
    assert.equal(row.active, 0);
    assert.equal(row.retail_price_cents, null);
    assert.equal(row.inventory_quantity, null);
    assert.ok(row.supplier_cost_verified_at);
    await env.DB.prepare(
      `UPDATE cj_variants SET active=1,retail_verified_at=CURRENT_TIMESTAMP,approved_supplier_cost_cents=1000,retail_policy_version='test-v1'`
    ).run();
    cost = '11.00';
    assert.equal((await syncCjCatalog(env)).status, 'success');
    row = await env.DB.prepare('SELECT * FROM cj_variants').first();
    assert.equal(row.supplier_cost_cents, 1100);
    assert.equal(row.retail_verified_at, null);
    assert.equal(row.approved_supplier_cost_cents, null);
    assert.equal(
      (await env.DB.prepare('SELECT amount_cents FROM sandbox_checkouts').first()).amount_cents,
      100
    );
  } finally {
    globalThis.fetch = old;
  }
});
