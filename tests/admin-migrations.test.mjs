import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

test('administrator migrations preserve existing order/payment records and isolate legacy QA data', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const directory = new URL('../migrations/', import.meta.url),
    files = readdirSync(directory)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  for (const file of files.slice(0, 5)) db.exec(readFileSync(new URL(file, directory), 'utf8'));
  db.exec(`INSERT INTO cj_products(id,cj_product_id,title,active) VALUES('cj:REAL','REAL','Legacy real product',1);
    INSERT INTO cj_products(id,cj_product_id,title,active) VALUES('cj:QA','QA-PENDING-P1','Renamed fixture, identified by its known ID',0);
    INSERT INTO cj_variants(id,product_id,cj_variant_id,supplier_cost_cents,retail_price_cents,active) VALUES('v1','cj:REAL','REAL-V',1000,2500,1);
    INSERT INTO cj_variants(id,product_id,cj_variant_id,active) VALUES('vq','cj:QA','QA-V',0);
    INSERT INTO sandbox_checkouts(id,status,amount_cents,currency,paypal_order_id,paypal_capture_id) VALUES('old-demo','paid',100,'USD','OLDORDER001','OLDCAPTURE01');
    INSERT INTO orders(id,public_reference,status,currency,subtotal_cents,shipping_cents,total_cents) VALUES('old-order','EXISTING-ORDER','paid','USD',1000,500,1500);
    INSERT INTO order_items(id,order_id,variant_id,title_snapshot,quantity,unit_price_cents) VALUES('old-item','old-order','v1','Existing order item',1,1000);`);
  const payment = { ...db.prepare('SELECT * FROM sandbox_checkouts').get() },
    order = { ...db.prepare('SELECT * FROM orders').get() };
  for (const file of files.slice(5)) db.exec(readFileSync(new URL(file, directory), 'utf8'));
  assert.deepEqual({ ...db.prepare('SELECT * FROM sandbox_checkouts').get() }, payment);
  assert.deepEqual({ ...db.prepare('SELECT * FROM orders').get() }, order);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_items').get().n, 1);
  const real = db.prepare("SELECT * FROM cj_variants WHERE id='v1'").get();
  assert.equal(real.supplier_cost_cents, 1000);
  assert.equal(real.retail_price_cents, 2500);
  assert.equal(real.active, 0);
  assert.equal(real.review_state, 'needs_verification');
  assert.equal(
    db.prepare("SELECT fixture_only FROM cj_products WHERE id='cj:QA'").get().fixture_only,
    1
  );
  assert.equal(
    db.prepare("SELECT fixture_only FROM cj_variants WHERE id='vq'").get().fixture_only,
    1
  );
  assert.throws(() => db.prepare("UPDATE cj_variants SET active=1 WHERE id='vq'").run());
  db.close();
});
