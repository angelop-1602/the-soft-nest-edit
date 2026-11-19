import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validCatalogId, validateCartPayload, getCartProductVariants,
  previewCart, handleCartPreview} from '../src/cart-preview.js';

const origin = 'https://thesoftnestedit.online';
const variantId = '3159B0AA-F9DA-4A39-87A3-12BC48B8E398';
const productId = '0F4C2DA3-DADF-4B1D-A827-D0439D4466CC';
const db = {prepare(sql) {
  return {
    bind(...params) {
      return {
        first: async () => {
          if (sql.startsWith('SELECT cj_product_id')) return {cj_product_id: productId, title:'Round Mirror'};
          if (sql.includes('FROM cj_variants v JOIN cj_products')) {
            if (params[0] !== variantId) return null;
            return {cj_variant_id:variantId,cj_sku:'CJFU28415320001',
              options_json:JSON.stringify({label:'Antique silver 80cm',image:'https://a.example/i.jpg'}),
              cj_product_id:productId,title:'Round Mirror',image_url:'https://a.example/p.jpg',
              supplier_cost_cents:10157,retail_price_cents:19000,inventory_quantity:40};
          }
          throw new Error('Unexpected SQL for first: '+sql);
        },
        all: async () => ({results:[{cj_variant_id:variantId,cj_sku:'CJFU28415320001',
          options_json:'{"label":"80cm","image":"https://a.example/i.jpg"}', supplier_cost_cents:10157}]}),
      };
    }
  };
}};
const post = (path, value, headers={}) => new Request(origin+path, {method:'POST',
  headers:{Origin:origin,'Content-Type':'application/json',...headers},
  body:JSON.stringify(value)});

test('product and cart IDs are validated',()=>{
  assert.equal(validCatalogId(productId),true);
  for(const id of ['../../abc', '', 'a'.repeat(140), 'abc;DROP TABLE', null])
    assert.equal(validCatalogId(id),false);
});
test('cart rejects bad quantities, duplicates and excessive lines',()=>{
  assert.deepEqual(validateCartPayload({items:[{variantId, quantity:2}]}),[{variantId,quantity:2}]);
  for(const items of [[{variantId,quantity:0}], [{variantId,quantity:6}],
    [{variantId,quantity:1},{variantId,quantity:1}],
    Array.from({length:16},(_,i)=>({variantId:`V${i}`, quantity:1}))])
    assert.equal(validateCartPayload({items}),null);
});
test('supplier variant discovery never leaks cost, price, stock, checkout',async()=>{
  const res=await getCartProductVariants(db,productId);
  assert.equal(res.checkoutEnabled,false);
  assert.equal(res.variants[0].id,variantId);
  for(const sensitive of ['10157','retail_price','inventory_quantity','paypal','cj_order'])
    assert.ok(!JSON.stringify(res).includes(sensitive));
});
test('planning cart loads current supplier variant but never provides payment',async()=>{
  const res=await previewCart(db,[{variantId,quantity:2},{variantId:'UNKNOWN',quantity:1}]);
  assert.equal(res.checkoutEnabled,false);
  assert.equal(res.unavailable,1);
  assert.equal(res.lines[0].quantity,2);
  assert.equal(res.lines[0].title,'Round Mirror');
  for(const sensitive of ['10157','19000','inventory_quantity','checkout_url','paypal','supplier_cost'])
    assert.ok(!JSON.stringify(res).includes(sensitive));
});
test('read-only product variant endpoint validates IDs and methods',async()=>{
  assert.equal((await handleCartPreview(new Request(origin+'/api/catalog/variants?productId=../../'),{DB:db},'variants')).status,400);
  assert.equal((await handleCartPreview(post('/api/catalog/variants',{}),{DB:db},'variants')).status,405);
  const res=await handleCartPreview(new Request(origin+'/api/catalog/variants?productId='+productId),{DB:db},'variants');
  assert.equal(res.status,200); assert.equal((await res.json()).variants.length,1);
});
test('POST cart refuses cross-origin, wrong content-type and invalid requests',async()=>{
  assert.equal((await handleCartPreview(post('/api/catalog/cart',{items:[]},{Origin:'https://evil.test'}),{DB:db},'cart')).status,403);
  assert.equal((await handleCartPreview(new Request(origin+'/api/catalog/cart',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:'hi'}),{DB:db},'cart')).status,415);
  assert.equal((await handleCartPreview(post('/api/catalog/cart',{items:[{variantId,quantity:999}]}),{DB:db},'cart')).status,400);
  const res=await handleCartPreview(post('/api/catalog/cart',{items:[{variantId,quantity:1}]}),{DB:db},'cart');
  assert.equal(res.status,200); assert.equal((await res.json()).checkoutEnabled,false);
});
