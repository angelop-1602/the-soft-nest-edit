import { cjAuthorized } from './cj-client.js';
import { moneyCents, buildCjFreightTrial } from './commerce-math.js';
import { freightOptions, QUOTE_TTL_MS } from './cj-shipping.js';
import { CommerceError, validZip } from './commerce-security.js';
import { safeImage } from './cj-sync.js';
import { safeVariantOptions } from './catalog-preview.js';
import { commit, shippingFingerprint, supplierIssues, version } from './admin-products-data.js';
import { touchProduct } from './admin-products-actions.js';

function preflight(p, v, payload) {
  if (
    p.review_version !== version(payload.expectedProductVersion) ||
    v.review_version !== version(payload.expectedVersion)
  )
    throw new CommerceError(
      'edit_conflict',
      'Reload this product before checking the supplier.',
      409
    );
  if (p.fixture_only === 1 || v.fixture_only === 1)
    throw new CommerceError(
      'fixture_not_for_sale',
      'Isolated fixtures cannot contact the real supplier.',
      409
    );
}
function errorCode(error) {
  return typeof error?.code === 'string' && /^CJ_[A-Z0-9_]{1,50}$/.test(error.code)
    ? error.code
    : 'CJ_CHECK_UNAVAILABLE';
}
export async function verifySupplier(env, actor, p, v, payload, policyState) {
  preflight(p, v, payload);
  if (!['US', 'CN'].includes(payload.origin))
    throw new CommerceError('invalid_origin', 'Select a US or CN warehouse origin.', 400);
  let cost = null,
    stock = null,
    verified = false,
    code = null,
    sku = v.cj_sku,
    options = v.options_json;
  try {
    const data = await cjAuthorized(env, '/product/variant/queryByVid', {
      search: { vid: v.cj_variant_id, features: 'enable_inventory' }
    });
    if (String(data?.vid) !== v.cj_variant_id || String(data?.pid) !== p.cj_product_id)
      throw new Error('Unverified identity');
    cost = moneyCents(data.variantSellPrice);
    if (cost === null || cost < 1) {
      cost = null;
      throw new Error('Unverified cost');
    }
    const inventories = Array.isArray(data.inventories)
      ? data.inventories.filter((i) => i.countryCode === payload.origin)
      : [];
    if (
      inventories.length === 1 &&
      Number(inventories[0].verifiedWarehouse) === 1 &&
      Number.isSafeInteger(inventories[0].cjInventory) &&
      inventories[0].cjInventory >= 0
    )
      stock = inventories[0].cjInventory;
    verified = stock !== null;
    if (typeof data.variantSku === 'string' && data.variantSku.length <= 200) sku = data.variantSku;
    if (typeof data.variantKey === 'string')
      options = JSON.stringify({
        label: data.variantKey.slice(0, 300),
        image: safeImage(data.variantImage) || safeVariantOptions(v.options_json).image
      });
  } catch (error) {
    code = errorCode(error);
  }
  const status = verified ? 'verified' : code ? 'error' : 'not_verified';
  await commit(
    env.DB,
    p,
    payload.expectedProductVersion,
    [{ ...v, expectedVersion: payload.expectedVersion }],
    policyState.revision,
    actor,
    'supplier_check',
    code || 'Exact variant cost and warehouse inventory checked',
    ({ condition, mutation, now }) => {
      const timestamp = new Date(now).toISOString();
      return [
        env.DB.prepare(
          `UPDATE cj_variants SET supplier_cost_cents=COALESCE(?,supplier_cost_cents),supplier_cost_verified_at=?,
        inventory_quantity=?,inventory_verified_at=?,origin_country_code=?,cj_sku=?,options_json=?,review_version=review_version+1,
        active=CASE WHEN ?=1 AND ?>0 THEN active ELSE 0 END,review_state=CASE WHEN ?=1 AND ?>0 THEN review_state ELSE 'needs_verification' END,
        approved_review_version=CASE WHEN ?=1 AND ?>0 AND active=1 THEN review_version+1 ELSE NULL END,last_admin_mutation=? WHERE id=? AND ${condition}`
        ).bind(
          cost,
          cost === null ? null : timestamp,
          stock,
          verified ? timestamp : null,
          verified ? payload.origin : null,
          sku,
          options,
          verified ? 1 : 0,
          stock ?? 0,
          verified ? 1 : 0,
          stock ?? 0,
          verified ? 1 : 0,
          stock ?? 0,
          mutation,
          v.id,
          mutation
        ),
        // The existing cost-change trigger intentionally cleared provenance; this exact live check restores cost freshness only.
        env.DB.prepare(
          `UPDATE cj_variants SET supplier_cost_verified_at=? WHERE id=? AND last_admin_mutation=? AND ${condition}`
        ).bind(cost === null ? null : timestamp, v.id, mutation, mutation),
        env.DB.prepare(
          `INSERT INTO admin_supplier_checks(id,variant_id,status,origin,error_code,checked_ms,actor_sub)
        SELECT ?,?,?,?,?,?,? WHERE ${condition}`
        ).bind(
          crypto.randomUUID(),
          v.id,
          status,
          verified ? payload.origin : null,
          code,
          now,
          actor.sub,
          mutation
        ),
        touchProduct(env.DB, p, condition, mutation)
      ];
    }
  );
  return {
    status,
    errorCode: code,
    message: verified
      ? stock > 0
        ? 'Verified CJ stock and supplier cost.'
        : 'Verified stock is zero; sales are blocked.'
      : 'Not verified. Previous supplier freshness was cleared; sales are blocked.'
  };
}
export async function verifyShipping(env, actor, p, v, payload, policyState) {
  preflight(p, v, payload);
  if (
    !validZip(payload.zip) ||
    !Number.isInteger(payload.quantity) ||
    payload.quantity < 1 ||
    payload.quantity > 5
  )
    throw new CommerceError(
      'invalid_destination',
      'Enter a valid US ZIP and quantity from 1–5.',
      400
    );
  const issues = supplierIssues(v);
  if (issues.length || v.inventory_quantity < payload.quantity)
    throw new CommerceError(
      'supplier_not_verified',
      'Verify sufficient CJ stock, cost and warehouse origin first.',
      409
    );
  let methods = [],
    code = null;
  try {
    const body = buildCjFreightTrial({
      originCountryCode: v.origin_country_code,
      destinationZip: payload.zip,
      items: [{ vid: v.cj_variant_id, quantity: payload.quantity }]
    });
    methods = freightOptions(
      await cjAuthorized(env, '/logistic/freightCalculate', { method: 'POST', body })
    );
  } catch (error) {
    code = errorCode(error);
  }
  const status = code ? 'error' : methods.length ? 'available' : 'unavailable';
  const fingerprint = await shippingFingerprint(p, v);
  await commit(
    env.DB,
    p,
    payload.expectedProductVersion,
    [{ ...v, expectedVersion: payload.expectedVersion }],
    policyState.revision,
    actor,
    'shipping_check',
    code || 'US ZIP-specific trial shipping check',
    ({ condition, mutation, now }) => [
      env.DB.prepare(
        `INSERT INTO admin_shipping_checks(id,variant_id,origin,destination_zip,quantity,status,methods_json,fingerprint,checked_ms,expires_ms,error_code,actor_sub)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${condition}`
      ).bind(
        crypto.randomUUID(),
        v.id,
        v.origin_country_code,
        payload.zip,
        payload.quantity,
        status,
        JSON.stringify(methods),
        fingerprint,
        now,
        now + QUOTE_TTL_MS,
        code,
        actor.sub,
        mutation
      ),
      env.DB.prepare(
        `UPDATE cj_variants SET review_version=review_version+1,approved_review_version=CASE WHEN active=1 THEN review_version+1 ELSE NULL END,
      last_admin_mutation=? WHERE id=? AND ${condition}`
      ).bind(mutation, v.id, mutation),
      env.DB.prepare(
        `UPDATE cj_products SET review_version=review_version+1,last_admin_mutation=? WHERE id=? AND ${condition}`
      ).bind(mutation, p.id, mutation)
    ]
  );
  return {
    status,
    errorCode: code,
    message: code
      ? 'Shipping could not be verified. Try again after the supplier cooldown.'
      : methods.length
        ? 'Estimate recorded for this exact variant, origin, quantity and ZIP only.'
        : 'No shipping methods returned for this destination. This does not describe every US destination.'
  };
}
