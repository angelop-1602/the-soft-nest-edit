/** Private catalog queries and review preconditions. Call only after authentication. */
import { CommerceError, digest } from './commerce-security.js';
import { validCatalogId } from './cart-preview.js';
import { safeImage } from './cj-sync.js';
import { safeVariantOptions } from './catalog-preview.js';
import { recent, minimumUnitRetail, effectiveRetailPolicy, priceBasket } from './retail-pricing.js';

export const PRODUCT_CHECKS = [
  'photosAccurate',
  'descriptionAccurate',
  'sizeMaterialsVerified',
  'returnsReviewed',
  'restrictionsReviewed',
  'supplierReviewed',
  'complaintsReviewed'
];
export const VARIANT_CHECKS = ['mappingReviewed', 'optionsReviewed', 'restrictionsReviewed'];
export const parseObject = (raw) => {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
export function text(value, max, min = 0) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    value.trim().length < min ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw new CommerceError(
      'invalid_input',
      'A review field is missing, too long or invalid.',
      400
    );
  return value.trim();
}
export function version(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new CommerceError('invalid_version', 'Refresh the product before editing.', 400);
  return value;
}
export async function productRecord(db, pid) {
  if (!validCatalogId(pid)) throw new CommerceError('invalid_product', 'Invalid product ID.', 400);
  const product = await db
    .prepare('SELECT * FROM cj_products WHERE cj_product_id=?')
    .bind(pid)
    .first();
  if (!product) throw new CommerceError('not_found', 'Product not found.', 404);
  return product;
}
export async function variantRecord(db, product, vid) {
  if (!validCatalogId(vid)) throw new CommerceError('invalid_variant', 'Invalid variant ID.', 400);
  const row = await db
    .prepare(`SELECT * FROM cj_variants WHERE cj_variant_id=? AND product_id=?`)
    .bind(vid, product.id)
    .first();
  if (!row) throw new CommerceError('not_found', 'Variant not found.', 404);
  return row;
}
export function qualityIssues(p, v) {
  const issues = [];
  const pr = parseObject(p.review_json),
    vr = parseObject(v.review_json);
  if (p.fixture_only === 1 || v.fixture_only === 1)
    issues.push('This fixture is permanently ineligible for sales.');
  if (!validCatalogId(p.cj_product_id) || !validCatalogId(v.cj_variant_id) || v.product_id !== p.id)
    issues.push('Variant identity mapping is invalid.');
  if (typeof v.cj_sku !== 'string' || !v.cj_sku.trim()) issues.push('A supplier SKU is required.');
  if (!safeImage(p.image_url)) issues.push('A valid HTTPS product image is required.');
  if (!p.title.trim() || p.description_text.trim().length < 30)
    issues.push('Review the title and add an accurate description (at least 30 characters).');
  for (const key of PRODUCT_CHECKS)
    if (pr[key] !== true) issues.push('Product checklist incomplete: ' + key);
  if (
    pr.returnEligibility !== 'eligible' ||
    typeof pr.returnNotes !== 'string' ||
    pr.returnNotes.trim().length < 20
  )
    issues.push('Confirm return eligibility and document the return restrictions.');
  if (pr.restrictionStatus !== 'clear')
    issues.push('Restricted/prohibited product review must be clear.');
  if (typeof pr.sizeMaterialNotes !== 'string' || pr.sizeMaterialNotes.trim().length < 10)
    issues.push('Document verified size and materials.');
  for (const key of VARIANT_CHECKS)
    if (vr[key] !== true) issues.push('Variant checklist incomplete: ' + key);
  return issues;
}
export function supplierIssues(v, now = Date.now()) {
  const issues = [];
  if (
    !Number.isSafeInteger(v.supplier_cost_cents) ||
    v.supplier_cost_cents < 1 ||
    !recent(v.supplier_cost_verified_at, now)
  )
    issues.push('Supplier cost needs a current verified check.');
  if (
    !Number.isSafeInteger(v.inventory_quantity) ||
    v.inventory_quantity < 1 ||
    !recent(v.inventory_verified_at, now)
  )
    issues.push('Current verified CJ warehouse stock is required.');
  if (!['US', 'CN'].includes(v.origin_country_code))
    issues.push('Verify a US or CN warehouse origin.');
  return issues;
}
export async function shippingFingerprint(p, v) {
  return digest(
    JSON.stringify({
      pid: p.cj_product_id,
      vid: v.cj_variant_id,
      sku: v.cj_sku,
      options: v.options_json,
      origin: v.origin_country_code,
      cost: v.supplier_cost_cents,
      title: p.title,
      image: p.image_url,
      description: p.description_text
    })
  );
}
export async function freshShipping(db, p, v) {
  return db
    .prepare(
      `SELECT c.* FROM admin_shipping_checks c WHERE variant_id=? AND fingerprint=?
    AND origin=? AND quantity=1 AND status='available' AND expires_ms>?
    AND NOT EXISTS(SELECT 1 FROM admin_shipping_checks newer WHERE newer.variant_id=c.variant_id
      AND newer.destination_zip=c.destination_zip AND newer.origin=c.origin AND newer.quantity=c.quantity
      AND newer.fingerprint=c.fingerprint AND newer.rowid>c.rowid)
    ORDER BY checked_ms DESC,c.rowid DESC LIMIT 1`
    )
    .bind(v.id, await shippingFingerprint(p, v), v.origin_country_code || '', Date.now())
    .first();
}
export function priceIssues(v, policy) {
  const issues = [];
  if (!policy) return ['Configure a retail pricing policy.'];
  if (
    !Number.isSafeInteger(v.retail_price_cents) ||
    v.retail_price_cents < 1 ||
    !recent(v.retail_verified_at, Date.now(), 365 * 86400000) ||
    v.approved_supplier_cost_cents !== v.supplier_cost_cents ||
    v.retail_policy_version !== policy.version
  )
    issues.push('Save approved pricing against the current verified cost and policy.');
  const effective = effectiveRetailPolicy(v, policy);
  const floor =
    effective && Number.isSafeInteger(v.supplier_cost_cents)
      ? minimumUnitRetail(v.supplier_cost_cents, effective)
      : null;
  if (floor === null || v.retail_price_cents < floor)
    issues.push('Retail price does not meet the pricing or acknowledged exception policy.');
  if (v.retail_price_cents > policy.maxTotalCents)
    issues.push('Retail price exceeds the configured test spending ceiling.');
  return issues;
}
export async function approvalIssues(db, p, v, policy, checks) {
  const issues = [...qualityIssues(p, v), ...supplierIssues(v), ...priceIssues(v, policy)];
  const fingerprint = checks ? await shippingFingerprint(p, v) : null;
  const shipping = checks
    ? checks.find(
        (c) =>
          c.fingerprint === fingerprint &&
          c.origin === v.origin_country_code &&
          c.quantity === 1 &&
          c.status === 'available' &&
          c.expires_ms > Date.now() &&
          !checks.some(
            (newer) =>
              newer.variant_id === c.variant_id &&
              newer.destination_zip === c.destination_zip &&
              newer.origin === c.origin &&
              newer.quantity === c.quantity &&
              newer.fingerprint === c.fingerprint &&
              newer.check_sequence > c.check_sequence
          )
      )
    : await freshShipping(db, p, v);
  if (!shipping)
    issues.push('A fresh, destination-specific US shipping check for one unit is required.');
  if (
    shipping &&
    policy &&
    Number.isSafeInteger(v.retail_price_cents) &&
    v.retail_price_cents > 0
  ) {
    const methods = JSON.parse(shipping.methods_json);
    if (
      !methods.length ||
      !priceBasket(
        [
          {
            supplierCostCents: v.supplier_cost_cents,
            unitPriceCents: v.retail_price_cents,
            pricingExceptionJson: v.pricing_exception_json,
            quantity: 1
          }
        ],
        methods[0].freightCents,
        policy
      )
    )
      issues.push(
        'The retail price plus verified shipping does not fit the complete pricing policy and spending ceiling.'
      );
  }
  return { issues, shipping };
}
export function profitBreakdown(
  v,
  policy,
  freightCents,
  retailPriceCents = v.retail_price_cents,
  exceptionJson = v.pricing_exception_json
) {
  if (
    !policy ||
    !Number.isSafeInteger(v.supplier_cost_cents) ||
    v.supplier_cost_cents < 1 ||
    !recent(v.supplier_cost_verified_at, Date.now())
  )
    return null;
  const min = minimumUnitRetail(v.supplier_cost_cents, policy);
  const out = {
    minimumRetailCents: min,
    retailPriceCents,
    freightCents: freightCents ?? null,
    shippingRetailCents: null,
    processingFeeCents: null,
    bufferCents: policy.perItemBufferCents + policy.shippingBufferCents,
    estimatedProfitCents: null,
    netMarginBps: null
  };
  if (freightCents == null || !Number.isSafeInteger(retailPriceCents) || retailPriceCents < 1)
    return out;
  const priced = priceBasket(
    [
      {
        supplierCostCents: v.supplier_cost_cents,
        unitPriceCents: retailPriceCents,
        quantity: 1,
        pricingExceptionJson: exceptionJson
      }
    ],
    freightCents,
    policy
  );
  // Show truthful loss/profit even when the proposed price is rejected by policy.
  const illustrative =
    priced ||
    priceBasket(
      [{ supplierCostCents: v.supplier_cost_cents, unitPriceCents: min, quantity: 1 }],
      freightCents,
      policy
    );
  if (!illustrative) return out;
  const total = retailPriceCents + illustrative.shippingCents;
  const fees =
    policy.processingFixedCents +
    Number((BigInt(total) * BigInt(policy.processingVariableBps) + 9999n) / 10000n);
  const profit = total - v.supplier_cost_cents - freightCents - fees - out.bufferCents;
  return {
    ...out,
    shippingRetailCents: illustrative.shippingCents,
    processingFeeCents: fees,
    estimatedProfitCents: profit,
    netMarginBps: Math.floor((profit * 10000) / total),
    compliant: !!priced
  };
}
export async function detail(db, p, policy) {
  const variants = (
    await db
      .prepare('SELECT * FROM cj_variants WHERE product_id=? ORDER BY cj_variant_id LIMIT 101')
      .bind(p.id)
      .all()
  ).results;
  const out = [];
  const shippingRows = await productShippingChecks(db, p);
  for (const v of variants.slice(0, 100)) {
    const checks = shippingRows.filter((c) => c.variant_id === v.id);
    const { issues, shipping } = await approvalIssues(db, p, v, policy, checks);
    const methods = shipping ? JSON.parse(shipping.methods_json) : [];
    out.push({
      id: v.cj_variant_id,
      sku: v.cj_sku,
      options: safeVariantOptions(v.options_json),
      status: v.review_state,
      active: v.active === 1,
      fixtureOnly: v.fixture_only === 1 || p.fixture_only === 1,
      version: v.review_version,
      retailPriceCents: v.retail_price_cents,
      supplierCostCents: v.supplier_cost_cents,
      inventoryQuantity: v.inventory_quantity,
      origin: v.origin_country_code,
      syncedAt: v.synced_at,
      costVerifiedAt: v.supplier_cost_verified_at,
      stockVerifiedAt: v.inventory_verified_at,
      costVerified:
        Number.isSafeInteger(v.supplier_cost_cents) &&
        v.supplier_cost_cents > 0 &&
        recent(v.supplier_cost_verified_at, Date.now()),
      stockVerified:
        Number.isSafeInteger(v.inventory_quantity) &&
        v.inventory_quantity >= 0 &&
        ['US', 'CN'].includes(v.origin_country_code) &&
        recent(v.inventory_verified_at, Date.now()),
      retailVerifiedAt: v.retail_verified_at,
      review: parseObject(v.review_json),
      reason: v.review_reason,
      pricingException: parseObject(v.pricing_exception_json),
      approvalIssues: issues,
      profit: profitBreakdown(v, policy, methods[0]?.freightCents),
      shippingChecks: checks.map((c) => ({
        id: c.id,
        zip: c.destination_zip,
        origin: c.origin,
        quantity: c.quantity,
        status: c.status,
        checkedMs: c.checked_ms,
        expiresMs: c.expires_ms,
        current: false,
        methods: JSON.parse(c.methods_json),
        errorCode: c.error_code
      }))
    });
    // Check provenance as well as expiration; never label an old quote current.
    const fingerprint = await shippingFingerprint(p, v);
    for (const c of out.at(-1).shippingChecks) {
      const raw = checks.find((r) => r.id === c.id);
      c.current =
        raw.fingerprint === fingerprint &&
        c.expiresMs > Date.now() &&
        !checks.some(
          (n) =>
            n.destination_zip === raw.destination_zip &&
            n.origin === raw.origin &&
            n.quantity === raw.quantity &&
            n.fingerprint === raw.fingerprint &&
            n.check_sequence > raw.check_sequence
        );
    }
  }
  const history = (
    await db
      .prepare(
        `SELECT actor_email,auth_source,action,variant_id,before_json,after_json,reason,created_ms
    FROM admin_audit WHERE product_id=? OR (product_id IS NULL AND action='pricing_policy_changed') ORDER BY created_ms DESC,id DESC LIMIT 50`
      )
      .bind(p.id)
      .all()
  ).results;
  return {
    product: {
      id: p.cj_product_id,
      title: p.title,
      image: safeImage(p.image_url),
      description: p.description_text,
      status: p.review_state,
      version: p.review_version,
      fixtureOnly: p.fixture_only === 1,
      review: parseObject(p.review_json),
      reason: p.review_reason,
      syncedAt: p.synced_at
    },
    variants: out,
    hasMoreVariants: variants.length > 100,
    history: history.map((h) => ({
      ...h,
      before: parseObject(h.before_json),
      after: parseObject(h.after_json),
      before_json: undefined,
      after_json: undefined
    }))
  };
}
export async function productShippingChecks(db, p) {
  return (
    await db
      .prepare(
        `SELECT * FROM (SELECT c.*,c.rowid AS check_sequence,
    ROW_NUMBER() OVER(PARTITION BY c.variant_id ORDER BY c.checked_ms DESC,c.rowid DESC) AS rn
    FROM admin_shipping_checks c JOIN cj_variants v ON v.id=c.variant_id WHERE v.product_id=?) WHERE rn<=10 ORDER BY checked_ms DESC,check_sequence DESC`
      )
      .bind(p.id)
      .all()
  ).results;
}

/** Atomic guard plus conditionally applied writes. D1 batch rolls back the entire transaction on error. */
export async function commit(
  db,
  p,
  expectedVersion,
  variants,
  policyRevision,
  actor,
  action,
  reason,
  build
) {
  const mutation = crypto.randomUUID(),
    now = Date.now();
  const params = [mutation, p.id, now, p.id, version(expectedVersion), policyRevision];
  let predicate = `p.id=? AND p.review_version=? AND EXISTS(SELECT 1 FROM admin_pricing_policy WHERE id=1 AND revision=?)`;
  const expected = variants.map((v) => ({
    id: v.id,
    version: version(v.expectedVersion),
    shippingCheckId: v.shippingCheck?.id || null
  }));
  predicate += ` AND NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN cj_variants v ON v.id=json_extract(e.value,'$.id')
    WHERE v.id IS NULL OR v.product_id<>p.id OR v.review_version<>json_extract(e.value,'$.version')
    OR (json_extract(e.value,'$.shippingCheckId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM admin_shipping_checks c
      WHERE c.id=json_extract(e.value,'$.shippingCheckId') AND c.variant_id=v.id AND c.status='available'
      AND c.expires_ms>CAST(strftime('%s','now') AS INTEGER)*1000
      AND NOT EXISTS(SELECT 1 FROM admin_shipping_checks n WHERE n.variant_id=c.variant_id AND n.destination_zip=c.destination_zip
        AND n.origin=c.origin AND n.quantity=c.quantity AND n.fingerprint=c.fingerprint AND n.rowid>c.rowid))))`;
  params.push(JSON.stringify(expected));
  const guard = db
    .prepare(
      `INSERT INTO admin_mutations(id,product_id,created_ms) SELECT ?,?,? FROM cj_products p WHERE ${predicate}`
    )
    .bind(...params);
  const condition = 'EXISTS(SELECT 1 FROM admin_mutations WHERE id=?)';
  const statements = build({ mutation, now, condition });
  const audit = db
    .prepare(
      `INSERT INTO admin_audit(id,actor_sub,actor_email,auth_source,action,product_id,before_json,after_json,reason,created_ms)
    SELECT ?,?,?,?,?,?, ?,json_object('productVersion',review_version,'productState',review_state,'description',description_text,'review',review_json),?,? FROM cj_products WHERE id=? AND ${condition}`
    )
    .bind(
      crypto.randomUUID(),
      actor.sub,
      actor.email,
      actor.source,
      action,
      p.id,
      JSON.stringify({
        productVersion: p.review_version,
        state: p.review_state,
        description: p.description_text,
        review: p.review_json
      }),
      reason,
      now,
      p.id,
      mutation
    );
  const before = variants.map((v) => ({
    id: v.id,
    before: JSON.stringify({
      version: v.review_version,
      state: v.review_state,
      priceCents: v.retail_price_cents,
      costCents: v.supplier_cost_cents,
      inventory: v.inventory_quantity,
      origin: v.origin_country_code,
      review: v.review_json,
      pricingException: v.pricing_exception_json
    })
  }));
  const variantAudit = db
    .prepare(
      `INSERT INTO admin_audit(id,actor_sub,actor_email,auth_source,action,product_id,variant_id,before_json,after_json,reason,created_ms)
    SELECT lower(hex(randomblob(16))),?,?,?,?,?,v.id,json_extract(e.value,'$.before'),
      json_object('version',v.review_version,'state',v.review_state,'priceCents',v.retail_price_cents,'costCents',v.supplier_cost_cents,
        'inventory',v.inventory_quantity,'origin',v.origin_country_code,'review',v.review_json,'pricingException',v.pricing_exception_json),?,?
    FROM json_each(?) e JOIN cj_variants v ON v.id=json_extract(e.value,'$.id') WHERE ${condition}`
    )
    .bind(
      actor.sub,
      actor.email,
      actor.source,
      action,
      p.id,
      reason,
      now,
      JSON.stringify(before),
      mutation
    );
  const result = await db.batch([guard, ...statements, audit, variantAudit]);
  if (result[0].meta?.changes !== 1)
    throw new CommerceError(
      'edit_conflict',
      'This product or policy changed. Reload before saving.',
      409
    );
  return mutation;
}
