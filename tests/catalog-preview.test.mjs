import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCatalogPreview, parsePreviewPage, safeVariantOptions, serializePreviewProduct } from '../src/catalog-preview.js';
import worker from '../src/index.js';

test('page bounds are strict', () => {
  assert.equal(parsePreviewPage(null), 1);
  assert.equal(parsePreviewPage('1'), 1);
  assert.equal(parsePreviewPage('100'), 100);
  for (const bad of ['0', '-1', '01', '1.0', '101', 'xyz', '1;DROP TABLE']) {
    assert.equal(parsePreviewPage(bad), null);
  }
});

test('supplier variant options are parsed without trusting markup or scheme', () => {
  assert.deepEqual(safeVariantOptions('{"label":"Antique Silver","image":"javascript:bad"}'),
    { label: 'Antique Silver', image: null });
  assert.deepEqual(safeVariantOptions('not json'), { label: '', image: null });
});

test('preview output never contains supplier or retail costs', () => {
  const row = { cj_product_id: 'abc', id: 'cj:abc', title: 'Round Mirror',
    image_url: 'https://cf.cjdropshipping.com/m.jpg', variant_count: 1,
    supplier_cost_cents: 10157, retail_price_cents: 15499, api_key: 'SECRET' };
  const result = serializePreviewProduct(row,
    [{ cj_sku: 'SKU-A', options_json: '{"label":"silver"}', supplier_cost_cents: 10157 }]);
  const s = JSON.stringify(result);
  assert.equal(result.variants[0].sku, 'SKU-A');
  assert.equal(result.variantCount, 1);
  assert.ok(!s.includes('10157'));
  assert.ok(!s.includes('15499'));
  assert.ok(!s.includes('SECRET'));
});

function mockDb() {
  return { prepare(sql) {
    if (sql.includes('SELECT COUNT(*) AS total FROM cj_products')) {
      return { first: async () => ({ total: 1 }) };
    }
    if (sql.includes('FROM cj_products p ORDER BY')) {
      return { bind(limit, offset) {
        assert.equal(limit, 16); assert.equal(offset, 0);
        return { all: async () => ({ results: [{
          cj_product_id: 'abc', id: 'cj:abc', title: 'Mirror',
          image_url: 'https://cf.cjdropshipping.com/m.jpg', variant_count: 1
        }] }) };
      } };
    }
    if (sql.includes('FROM cj_variants WHERE product_id IN')) {
      return { bind(id) {
        assert.equal(id, 'cj:abc');
        return { all: async () => ({ results: [{
          product_id: 'cj:abc', cj_sku: 'SKU-B', options_json: '{"label":"80 cm"}'
        }] }) };
      } };
    }
    if (sql.includes('SELECT last_status FROM cj_sync_state')) {
      return { first: async () => ({ last_status: 'success' }) };
    }
    throw new Error('Unexpected SQL: ' + sql);
  } };
}

test('read-only API returns no prices or checkout', async () => {
  const response = await worker.fetch(
    new Request('https://thesoftnestedit.online/api/catalog/preview?page=1'),
    { DB: mockDb(), CJDROPSHIPPING_API: 'SECRET' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  const raw = await response.text();
  const data = JSON.parse(raw);
  assert.equal(data.checkoutEnabled, false);
  assert.equal(data.supplierSyncStatus, 'success');
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].variants[0].label, '80 cm');
  assert.equal(data.total, 1);
  for (const secret of ['SECRET', 'supplier_cost', 'retail_price', 'inventory_quantity', 'checkout_url']) {
    assert.ok(!raw.includes(secret));
  }
});

test('invalid page and non-GET are rejected, no DB reads', async () => {
  const env = { DB: { prepare: () => { throw new Error('Must not reach DB'); } } };
  const bad = await worker.fetch(new Request('https://thesoftnestedit.online/api/catalog/preview?page=0'), env);
  assert.equal(bad.status, 400);
  const post = await worker.fetch(new Request('https://thesoftnestedit.online/api/catalog/preview', { method: 'POST' }), env);
  assert.equal(post.status, 405);
});

test('catalog preview is explicitly marked public and cannot trigger purchases', async () => {
  const value = await getCatalogPreview(mockDb(), 1);
  assert.equal(value.publiclyAccessible, true);
  assert.equal(value.kind, 'supplier_catalog_preview');
  assert.equal(value.checkoutEnabled, false);
  assert.equal('paypal' in value, false);
  assert.equal('cjOrder' in value, false);
});
