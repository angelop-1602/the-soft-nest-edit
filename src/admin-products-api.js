import { authenticateAdmin, adminReply, ADMIN_HEADERS } from './admin-auth.js';
import { CommerceError, readJson } from './commerce-security.js';
import { pricingPolicyState, recent } from './retail-pricing.js';
import {
  productRecord,
  variantRecord,
  detail,
  freshShipping,
  profitBreakdown
} from './admin-products-data.js';
import {
  saveProductReview,
  saveVariantReview,
  saveRetailPrice,
  decide,
  savePolicy,
  proposedException
} from './admin-products-actions.js';
import { verifySupplier, verifyShipping } from './admin-cj-verification.js';
import { moneyCents } from './commerce-math.js';
import { dashboardPage } from './admin-products-page.js';

const filters = new Set([
  'all',
  'pending_review',
  'needs_verification',
  'approved',
  'rejected',
  'disabled',
  'out_of_stock',
  'missing_pricing',
  'shipping_unavailable'
]);
async function listProducts(db, url) {
  const filter = url.searchParams.get('filter') || 'all',
    q = (url.searchParams.get('q') || '').trim();
  const raw = url.searchParams.get('page') || '1';
  if (!filters.has(filter) || q.length > 100 || !/^[1-9]\d{0,4}$/.test(raw))
    throw new CommerceError('invalid_search', 'Invalid search, filter or page.', 400);
  const page = Number(raw),
    params = [];
  let where = '1=1';
  if (q) {
    where += ` AND (p.title LIKE ? ESCAPE '!' OR p.cj_product_id LIKE ? ESCAPE '!' OR EXISTS(SELECT 1 FROM cj_variants s WHERE s.product_id=p.id AND (s.cj_sku LIKE ? ESCAPE '!' OR s.cj_variant_id LIKE ? ESCAPE '!')))`;
    const pattern = '%' + q.replace(/[!%_]/g, (c) => '!' + c) + '%';
    params.push(pattern, pattern, pattern, pattern);
  }
  if (
    ['pending_review', 'needs_verification', 'approved', 'rejected', 'disabled'].includes(filter)
  ) {
    where +=
      ' AND (p.review_state=? OR EXISTS(SELECT 1 FROM cj_variants s WHERE s.product_id=p.id AND s.review_state=?))';
    params.push(filter, filter);
  }
  if (filter === 'out_of_stock')
    where +=
      ' AND EXISTS(SELECT 1 FROM cj_variants s WHERE s.product_id=p.id AND s.inventory_quantity=0)';
  if (filter === 'missing_pricing')
    where +=
      ' AND EXISTS(SELECT 1 FROM cj_variants s WHERE s.product_id=p.id AND (s.retail_price_cents IS NULL OR s.retail_verified_at IS NULL))';
  if (filter === 'shipping_unavailable') {
    where += ` AND NOT EXISTS(SELECT 1 FROM admin_shipping_checks c JOIN cj_variants s ON s.id=c.variant_id WHERE s.product_id=p.id
      AND c.origin=s.origin_country_code AND c.status='available' AND c.expires_ms>?
      AND NOT EXISTS(SELECT 1 FROM admin_shipping_checks n WHERE n.variant_id=c.variant_id AND n.destination_zip=c.destination_zip
        AND n.origin=c.origin AND n.quantity=c.quantity AND n.fingerprint=c.fingerprint AND n.rowid>c.rowid))`;
    params.push(Date.now());
  }
  const total = (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM cj_products p WHERE ${where}`)
      .bind(...params)
      .first()
  ).n;
  const rows = (
    await db
      .prepare(
        `SELECT p.*,(SELECT COUNT(*) FROM cj_variants v WHERE v.product_id=p.id) AS variant_count,
    (SELECT COUNT(*) FROM cj_variants v WHERE v.product_id=p.id AND v.review_state='approved' AND v.active=1) AS approved_variants,
    (SELECT MIN(retail_price_cents) FROM cj_variants v WHERE v.product_id=p.id) AS retail_from
    FROM cj_products p WHERE ${where} ORDER BY p.synced_at DESC,p.id LIMIT 12 OFFSET ?`
      )
      .bind(...params, (page - 1) * 12)
      .all()
  ).results;
  return {
    page,
    pageSize: 12,
    total,
    pages: Math.ceil(total / 12),
    products: rows.map((p) => ({
      id: p.cj_product_id,
      title: p.title,
      image: p.image_url,
      status: p.review_state,
      version: p.review_version,
      fixtureOnly: p.fixture_only === 1,
      variantCount: p.variant_count,
      approvedVariants: p.approved_variants,
      retailFromCents: p.retail_from,
      syncedAt: p.synced_at
    }))
  };
}
export const isAdminPath = (path) =>
  path === '/admin/products' ||
  path.startsWith('/admin/products/') ||
  path === '/api/admin' ||
  path.startsWith('/api/admin/');
export function adminError(error) {
  return error instanceof CommerceError
    ? adminReply({ error: error.message, code: error.code }, error.status)
    : adminReply(
        {
          error: 'The administrator service is unavailable. No changes were confirmed.',
          code: 'admin_unavailable'
        },
        503
      );
}
export async function handleAdmin(request, env, actor) {
  const url = new URL(request.url);
  if (
    url.pathname === '/admin/products' ||
    url.pathname === '/admin/products/' ||
    url.pathname === '/admin/products/index.html'
  ) {
    if (request.method !== 'GET') return adminReply({ error: 'Method not allowed' }, 405);
    return new Response(dashboardPage, {
      headers: { ...ADMIN_HEADERS, 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
  if (!url.pathname.startsWith('/api/admin/')) return adminReply({ error: 'Not found' }, 404);
  try {
    let payload;
    if (request.method === 'POST') {
      if (request.headers.get('X-Softnest-Admin') !== '1')
        throw new CommerceError('csrf_rejected', 'Administrator request header required.', 403);
      payload = await readJson(request, 24000);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new CommerceError('invalid_request', 'A JSON object is required.', 400);
    } else if (request.method !== 'GET') return adminReply({ error: 'Method not allowed' }, 405);
    if (url.pathname === '/api/admin/session' && request.method === 'GET')
      return adminReply({
        actor: { email: actor.email, source: actor.source },
        policy: await pricingPolicyState(env),
        customerCheckoutEnabled: false,
        cjFulfillmentEnabled: false
      });
    if (url.pathname === '/api/admin/policy' && request.method === 'POST') {
      await savePolicy(env, actor, payload, await pricingPolicyState(env));
      return adminReply({ policy: await pricingPolicyState(env) });
    }
    if (url.pathname === '/api/admin/products' && request.method === 'GET')
      return adminReply(await listProducts(env.DB, url));
    const match = url.pathname.match(
      /^\/api\/admin\/products\/([A-Za-z0-9_-]{1,128})(?:\/(review|decision)|\/variants\/([A-Za-z0-9_-]{1,128})\/(review|verify|shipping|price|price-preview))?$/
    );
    if (!match) return adminReply({ error: 'Not found' }, 404);
    const p = await productRecord(env.DB, match[1]),
      policyState = await pricingPolicyState(env);
    if (!match[2] && !match[3] && request.method === 'GET')
      return adminReply(await detail(env.DB, p, policyState.policy));
    if (request.method !== 'POST') return adminReply({ error: 'Method not allowed' }, 405);
    let verification;
    if (match[2] === 'review') await saveProductReview(env, actor, p, payload, policyState);
    else if (match[2] === 'decision') {
      const rows = (
        await env.DB.prepare(
          'SELECT * FROM cj_variants WHERE product_id=? ORDER BY cj_variant_id LIMIT 101'
        )
          .bind(p.id)
          .all()
      ).results;
      await decide(env, actor, p, rows, payload, policyState);
    } else if (match[3]) {
      const v = await variantRecord(env.DB, p, match[3]);
      if (match[4] === 'review') await saveVariantReview(env, actor, p, v, payload, policyState);
      if (match[4] === 'price') await saveRetailPrice(env, actor, p, v, payload, policyState);
      if (match[4] === 'verify')
        verification = await verifySupplier(env, actor, p, v, payload, policyState);
      if (match[4] === 'shipping')
        verification = await verifyShipping(env, actor, p, v, payload, policyState);
      if (match[4] === 'price-preview') {
        const price = moneyCents(payload.retailPriceUsd);
        if (
          !policyState.policy ||
          price === null ||
          price < 1 ||
          !Number.isSafeInteger(v.supplier_cost_cents) ||
          !recent(v.supplier_cost_verified_at, Date.now()) ||
          v.supplier_cost_cents < 1
        )
          throw new CommerceError(
            'invalid_price',
            'Verify supplier cost and enter a positive USD price.',
            400
          );
        let ex = null,
          warning = null;
        try {
          ex = proposedException(v, policyState.policy, price, payload, actor);
        } catch (e) {
          if (e instanceof CommerceError) warning = e.message;
          else throw e;
        }
        const shipping = await freshShipping(env.DB, p, v),
          methods = shipping ? JSON.parse(shipping.methods_json) : [];
        return adminReply({
          profit: profitBreakdown(v, policyState.policy, methods[0]?.freightCents, price, ex),
          warning
        });
      }
    } else return adminReply({ error: 'Not found' }, 404);
    return adminReply({
      ...(await detail(env.DB, await productRecord(env.DB, p.cj_product_id), policyState.policy)),
      ...(verification ? { verification } : {})
    });
  } catch (error) {
    return adminError(error);
  }
}
export async function handleAuthenticatedAdmin(request, env) {
  try {
    return await handleAdmin(request, env, await authenticateAdmin(request, env));
  } catch (error) {
    return adminError(error);
  }
}
