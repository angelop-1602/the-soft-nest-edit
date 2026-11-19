import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assessVariant, checkCartReadiness, validateItems, handleCheckoutReadiness} from '../src/cart-readiness.js';
const origin='https://thesoftnestedit.online';
const vid='08e7d49d-f70e-4454-898b-52c3229c262f';
const now=Date.parse('2026-11-19T09:00:00Z');
function row(overrides={}) {
  return {product_active:1,variant_active:1,retail_price_cents:19000,
    retail_verified_at:'2026-11-18 15:00:00',inventory_quantity:10,
    inventory_verified_at:'2026-11-19 08:00:00',...overrides};
}
function db(value) {return {prepare(sql){
  assert.ok(sql.includes('FROM cj_variants v JOIN cj_products p'));
  assert.ok(!sql.includes('supplier_cost'));
  return {bind(id){assert.equal(id,vid);return {first:async()=>value};}};
}};}
function post(value, headers={}) {return new Request(origin+'/api/checkout/readiness',{
  method:'POST', headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
}
test('validates cart before query and rejects duplicates',()=>{
  assert.deepEqual(validateItems({items:[{variantId:vid,quantity:2}]}),[{variantId:vid,quantity:2}]);
  assert.equal(validateItems({items:[{variantId:vid,quantity:0}]}),null);
  assert.equal(validateItems({items:[{variantId:vid,quantity:2},{variantId:vid,quantity:2}]}),null);
  assert.equal(validateItems({items:[{variantId:'xx;select',quantity:1}]}),null);
});
test('fail closed until retailer approved, price confirmed, fresh stock',()=>{
  assert.equal(assessVariant(row({product_active:0}),1,now).reason,'not_approved');
  assert.equal(assessVariant(row({retail_verified_at:null}),1,now).reason,'retail_price_unverified');
  assert.equal(assessVariant(row({retail_price_cents:null}),1,now).reason,'retail_price_unverified');
  assert.equal(assessVariant(row({inventory_quantity:null}),1,now).reason,'inventory_unverified');
  assert.equal(assessVariant(row({inventory_quantity:0}),1,now).reason,'insufficient_inventory');
  assert.equal(assessVariant(row({inventory_verified_at:'2026-11-17 00:00:00'}),1,now).reason,'inventory_not_recently_verified');
  assert.equal(assessVariant(row(),1,now).reason,'shipping_not_quoted');
});
test('approved variants only expose approved retail, never supplier costs',async()=>{
  const res=await checkCartReadiness(db({...row(),supplier_cost_cents:10157}),[{variantId:vid,quantity:2}],now);
  assert.equal(res.subtotalUsd,'380.00');
  assert.equal(res.lines[0].unitPriceUsd,'190.00');
  assert.equal(res.customerCheckoutEnabled,false);
  assert.equal(res.paypalCaptureEnabled,false);
  assert.equal(res.cjOrderSubmissionEnabled,false);
  assert.equal(res.grandTotalUsd,null);
  assert.equal(res.shippingUsd,null);
  assert.ok(!JSON.stringify(res).includes('10157'));
});
test('unknown or unapproved line prevents any payable subtotal',async()=>{
  const res=await checkCartReadiness(db(row({variant_active:0})),[{variantId:vid,quantity:1}],now);
  assert.equal(res.subtotalUsd,null);assert.equal(res.lines[0].unitPriceUsd,null);
});
test('readiness API rejects cross-origin, invalid content-type, invalid cart',async()=>{
  const mock=db(row());
  assert.equal((await handleCheckoutReadiness(post({items:[]},{Origin:'https://evil.test'}),{DB:mock})).status,403);
  const bad=new Request(origin+'/api/checkout/readiness',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:'x'});
  assert.equal((await handleCheckoutReadiness(bad,{DB:mock})).status,415);
  assert.equal((await handleCheckoutReadiness(post({items:[{variantId:vid,quantity:8}]}),{DB:mock})).status,400);
  assert.equal((await handleCheckoutReadiness(new Request(origin+'/api/checkout/readiness'),{DB:mock})).status,405);
});
test('live API can only read and returns no purchasable order route',async()=>{
  const result=await handleCheckoutReadiness(post({items:[{variantId:vid,quantity:1}]}),{DB:db(row())});
  assert.equal(result.status,200);
  const data=await result.json();
  assert.equal(data.customerCheckoutEnabled,false);
  assert.equal(data.cjOrderSubmissionEnabled,false);
  assert.equal(data.shippingUsd,null);
});
