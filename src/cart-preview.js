/**
 * The Soft Nest Edit: public, READ-ONLY CJ planning cart services.
 * No prices, costs, inventory, addresses, checkout or fulfillment are exposed.
 * This code cannot trigger PayPal or CJ order creation.
 */
import { safeImage } from './cj-sync.js';
import { safeVariantOptions } from './catalog-preview.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LINES = 15;
const MAX_QUANTITY = 5;

function clean(value, max = 250) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function validCatalogId(value) {
  return typeof value === 'string' && ID.test(value);
}

export function validateCartPayload(value) {
  if (!value || !Array.isArray(value.items) || value.items.length > MAX_LINES) return null;
  const seen = new Set();
  const items = [];
  for (const item of value.items) {
    if (!item || !validCatalogId(item.variantId) ||
      !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY ||
      seen.has(item.variantId)) return null;
    seen.add(item.variantId);
    items.push({ variantId: item.variantId, quantity: item.quantity });
  }
  return items;
}

export async function getCartProductVariants(db, productId) {
  if (!validCatalogId(productId)) return null;
  const product = await db.prepare('SELECT cj_product_id, title FROM cj_products WHERE cj_product_id=?')
    .bind(productId).first();
  if (!product) return null;
  const result = await db.prepare(`SELECT cj_variant_id, cj_sku, options_json
    FROM cj_variants WHERE product_id=? ORDER BY id LIMIT 100`)
    .bind('cj:' + productId).all();
  const variants = (result.results || []).map(row => {
    const options = safeVariantOptions(row.options_json);
    return { id: clean(row.cj_variant_id, 128), label: options.label || 'Default variant',
      sku: clean(row.cj_sku, 100) };
  }).filter(v => validCatalogId(v.id));
  return { productId, title: clean(product.title), variants, checkoutEnabled: false };
}

export async function previewCart(db, items) {
  const lines = [];
  let unavailable = 0;
  for (const item of items) {
    const row = await db.prepare(`SELECT v.cj_variant_id, v.cj_sku, v.options_json,
      p.cj_product_id, p.title, p.image_url
      FROM cj_variants v JOIN cj_products p ON p.id=v.product_id
      WHERE v.cj_variant_id=? LIMIT 1`).bind(item.variantId).first();
    if (!row) {
      unavailable++;
      continue;
    }
    const variant = safeVariantOptions(row.options_json);
    lines.push({
      variantId: clean(row.cj_variant_id, 128), productId: clean(row.cj_product_id, 128),
      title: clean(row.title), image: safeImage(row.image_url),
      variantLabel: variant.label || 'Default variant', sku: clean(row.cj_sku, 100),
      quantity: item.quantity
    });
  }
  return {
    kind: 'cj_planning_cart', checkoutEnabled: false,
    shippingVerified: false, retailPricingVerified: false,
    lines, unavailable,
    notice: 'This is a planning cart only. Prices, stock, US shipping and checkout are not yet verified.'
  };
}

const HEADERS = {
  'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer'
};
const json = (value, status = 200) => Response.json(value, { status, headers: HEADERS });

export async function handleCartPreview(request, env, route) {
  const url = new URL(request.url);
  if (route === 'variants') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const id = url.searchParams.get('productId');
    if (!validCatalogId(id)) return json({ error: 'Invalid product ID' }, 400);
    try {
      if (!env.DB) throw new Error('DB missing');
      const result = await getCartProductVariants(env.DB, id);
      return result ? json(result) : json({ error: 'Product not found' }, 404);
    } catch { return json({ error: 'Supplier catalog temporarily unavailable' }, 503); }
  }
  if (route === 'cart') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Origin rejected' }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || ''))
      return json({ error: 'JSON required' }, 415);
    if (Number(request.headers.get('Content-Length')) > 5000) return json({ error: 'Cart too large' }, 413);
    let payload;
    try {
      const raw = await request.text();
      if (raw.length > 5000) return json({ error: 'Cart too large' }, 413);
      payload = JSON.parse(raw);
    } catch { return json({ error: 'Invalid JSON' }, 400); }
    const items = validateCartPayload(payload);
    if (!items) return json({ error: 'Invalid cart items' }, 400);
    try {
      if (!env.DB) throw new Error('DB missing');
      return json(await previewCart(env.DB, items));
    } catch { return json({ error: 'Cart preview temporarily unavailable' }, 503); }
  }
  return json({ error: 'Not found' }, 404);
}
