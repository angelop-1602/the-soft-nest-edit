import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeProduct, normalizeVariant, priceToCents, safeImage } from '../src/cj-sync.js';
import worker from '../src/index.js';

test('exact cents without floats', () => {
  assert.equal(priceToCents('101.57'), 10157);
  assert.equal(priceToCents('0.01'), 1);
  assert.equal(priceToCents('1.5'), 150);
  assert.equal(priceToCents('100.999'), null);
  assert.equal(priceToCents('not quoted'), null);
  assert.equal(priceToCents(null), null);
});

test('supplier image must be a safe HTTPS URL', () => {
  assert.equal(safeImage('https://cf.cjdropshipping.com/test.jpg'), 'https://cf.cjdropshipping.com/test.jpg');
  assert.equal(safeImage('javascript:alert(1)'), null);
  assert.equal(safeImage('http://other.example/a.jpg'), null);
  assert.equal(safeImage('https://user:password@example.com/a.jpg'), null);
});

test('normalize documented CJ My Products response', () => {
  assert.deepEqual(normalizeProduct({
    productId: '01118E21-A8B9-45CE-A16C-75232FB8A14A',
    nameEn: 'Round Mirror', bigImage: 'https://cf.cjdropshipping.com/m.jpg', sku: 'CJFU2841532'
  }), {
    id: 'cj:01118E21-A8B9-45CE-A16C-75232FB8A14A',
    pid: '01118E21-A8B9-45CE-A16C-75232FB8A14A',
    title: 'Round Mirror', image: 'https://cf.cjdropshipping.com/m.jpg', sku: 'CJFU2841532'
  });
});

test('normalize CJ variant with USD supplier price', () => {
  const v = normalizeVariant({
    vid: '1D72A20A-D113-4FAB-B4BA-6FE1A6A14A3A',
    variantSku: 'CJFU28415320001', variantKey: 'Antique silver - 80cm',
    variantSellPrice: 101.57
  }, 'pid1');
  assert.equal(v.vid, '1D72A20A-D113-4FAB-B4BA-6FE1A6A14A3A');
  assert.equal(v.cost, 10157);
  assert.equal(JSON.parse(v.options).label, 'Antique silver - 80cm');
});

test('unknown APIs cannot expose the stored supplier token', async () => {
  const res = await worker.fetch(new Request('https://thesoftnestedit.online/api/cj/credentials'), {
    CJDROPSHIPPING_API: 'SECRET-KEY'
  });
  assert.equal(res.status, 404);
  assert.equal((await res.text()).includes('SECRET-KEY'), false);
});

test('health check keeps the old endpoint', async () => {
  const env = { DB: { prepare(sql) {
    assert.equal(sql, 'SELECT 1 AS connected');
    return { first: async () => ({ connected: 1 }) };
  } } };
  const res = await worker.fetch(new Request('https://thesoftnestedit.online/api/health'), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).database, 'connected');
});
