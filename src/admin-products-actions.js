import { CommerceError } from './commerce-security.js';
import { moneyCents } from './commerce-math.js';
import {
  pricingPolicy,
  recent,
  minimumUnitRetail,
  effectiveRetailPolicy
} from './retail-pricing.js';
import {
  PRODUCT_CHECKS,
  VARIANT_CHECKS,
  text,
  version,
  commit,
  approvalIssues,
  productShippingChecks
} from './admin-products-data.js';

function checklist(payload, keys) {
  const out = {};
  for (const key of keys) {
    if (typeof payload?.[key] !== 'boolean')
      throw new CommerceError('invalid_review', 'Complete every review checkbox.', 400);
    out[key] = payload[key];
  }
  return out;
}
export function touchProduct(db, p, condition, mutation) {
  return db
    .prepare(
      `UPDATE cj_products SET review_version=review_version+1,last_admin_mutation=?,
    active=CASE WHEN fixture_only=1 THEN 0 ELSE EXISTS(SELECT 1 FROM cj_variants WHERE product_id=cj_products.id AND active=1 AND review_state='approved') END,
    review_state=CASE WHEN fixture_only=1 THEN 'disabled' WHEN EXISTS(SELECT 1 FROM cj_variants WHERE product_id=cj_products.id AND active=1 AND review_state='approved') THEN 'approved'
      WHEN review_state IN ('disabled','rejected') THEN review_state ELSE 'needs_verification' END
    WHERE id=? AND ${condition}`
    )
    .bind(mutation, p.id, mutation);
}
export async function saveProductReview(env, actor, p, payload, policyState) {
  const description = text(payload.description, 6000),
    r = payload.review;
  const review = { ...checklist(r, PRODUCT_CHECKS) };
  if (
    !['unknown', 'eligible', 'ineligible'].includes(r.returnEligibility) ||
    !['unknown', 'clear', 'restricted'].includes(r.restrictionStatus)
  )
    throw new CommerceError(
      'invalid_review',
      'Select return eligibility and restriction status.',
      400
    );
  Object.assign(review, {
    returnEligibility: r.returnEligibility,
    restrictionStatus: r.restrictionStatus
  });
  for (const key of [
    'returnNotes',
    'sizeMaterialNotes',
    'supplierNotes',
    'complaintsNotes',
    'restrictionNotes'
  ])
    review[key] = text(r[key] ?? '', 2000);
  await commit(
    env.DB,
    p,
    payload.expectedVersion,
    [],
    policyState.revision,
    actor,
    'product_review_saved',
    'Quality and return review updated',
    ({ condition, mutation }) => [
      env.DB.prepare(
        `UPDATE cj_products SET description_text=?,review_json=?,review_version=review_version+1,last_admin_mutation=? WHERE id=? AND ${condition}`
      ).bind(description, JSON.stringify(review), mutation, p.id, mutation)
    ]
  );
}
export async function saveVariantReview(env, actor, p, v, payload, policyState) {
  const review = {
    ...checklist(payload.review, VARIANT_CHECKS),
    notes: text(payload.review.notes ?? '', 2000)
  };
  await commit(
    env.DB,
    p,
    payload.expectedProductVersion,
    [{ ...v, expectedVersion: payload.expectedVersion }],
    policyState.revision,
    actor,
    'variant_review_saved',
    'Variant mapping and specifications reviewed',
    ({ condition, mutation }) => [
      env.DB.prepare(
        `UPDATE cj_variants SET review_json=?,review_version=review_version+1,active=0,
      review_state=CASE WHEN fixture_only=1 THEN 'disabled' ELSE 'needs_verification' END,approved_review_version=NULL,last_admin_mutation=? WHERE id=? AND ${condition}`
      ).bind(JSON.stringify(review), mutation, v.id, mutation),
      touchProduct(env.DB, p, condition, mutation)
    ]
  );
}
export function proposedException(v, policy, price, payload, actor, now = Date.now()) {
  const minimum = minimumUnitRetail(v.supplier_cost_cents, policy);
  if (minimum === null)
    throw new CommerceError(
      'pricing_unavailable',
      'This supplier cost exceeds the pricing engine limits.',
      400
    );
  if (price >= minimum) return null;
  const e = payload.exception;
  if (
    policy.allowMarginExceptions !== true ||
    e?.acknowledged !== true ||
    !Number.isInteger(e.minimumMarginBps) ||
    e.minimumMarginBps < policy.exceptionMinimumMarginBps ||
    e.minimumMarginBps > policy.targetMarginBps ||
    !Number.isInteger(e.hours) ||
    e.hours < 1 ||
    e.hours > policy.exceptionMaxHours
  )
    throw new CommerceError(
      'margin_below_policy',
      'Price is below policy. Enable a bounded exception policy and explicitly acknowledge a documented exception.',
      400
    );
  const exception = {
    id: crypto.randomUUID(),
    actor: actor.sub,
    acknowledged: true,
    reason: text(e.reason, 1000, 20),
    minimumMarginBps: e.minimumMarginBps,
    createdMs: now,
    expiresMs: now + e.hours * 3600000,
    costCents: v.supplier_cost_cents,
    priceCents: price,
    policyJson: JSON.stringify(policy)
  };
  const effective = effectiveRetailPolicy(
    { ...v, retail_price_cents: price, pricing_exception_json: JSON.stringify(exception) },
    policy,
    now
  );
  if (!effective || price < minimumUnitRetail(v.supplier_cost_cents, effective))
    throw new CommerceError(
      'margin_below_exception',
      'Price is below even the acknowledged exception minimum.',
      400
    );
  return JSON.stringify(exception);
}
export async function saveRetailPrice(env, actor, p, v, payload, policyState) {
  const policy = policyState.policy,
    price = moneyCents(payload.retailPriceUsd);
  if (!policy)
    throw new CommerceError('pricing_unavailable', 'Configure the pricing policy first.', 400);
  if (price === null || price < 1 || price > policy.maxTotalCents)
    throw new CommerceError(
      'invalid_price',
      'Enter a positive USD price within the configured ceiling.',
      400
    );
  if (
    !Number.isSafeInteger(v.supplier_cost_cents) ||
    v.supplier_cost_cents < 1 ||
    !recent(v.supplier_cost_verified_at, Date.now())
  )
    throw new CommerceError(
      'unverified_cost',
      'Refresh and verify the supplier cost before pricing.',
      409
    );
  const exception = proposedException(v, policy, price, payload, actor);
  await commit(
    env.DB,
    p,
    payload.expectedProductVersion,
    [{ ...v, expectedVersion: payload.expectedVersion }],
    policyState.revision,
    actor,
    exception ? 'price_exception_acknowledged' : 'retail_price_changed',
    exception ? JSON.parse(exception).reason : 'Retail price approved against verified cost',
    ({ condition, mutation, now }) => [
      env.DB.prepare(
        `UPDATE cj_variants SET retail_price_cents=?,approved_supplier_cost_cents=supplier_cost_cents,
        retail_verified_at=?,retail_policy_version=?,pricing_exception_json=?,active=0,approved_review_version=NULL,
        review_state=CASE WHEN fixture_only=1 THEN 'disabled' ELSE 'needs_verification' END,review_version=review_version+1,last_admin_mutation=? WHERE id=? AND ${condition}`
      ).bind(
        price,
        new Date(now).toISOString(),
        policy.version,
        exception,
        mutation,
        v.id,
        mutation
      ),
      touchProduct(env.DB, p, condition, mutation)
    ]
  );
}
export async function decide(env, actor, p, allVariants, payload, policyState) {
  if (
    !['approve', 'reject', 'disable'].includes(payload.action) ||
    !['product', 'variants'].includes(payload.scope)
  )
    throw new CommerceError('invalid_decision', 'Invalid review decision.', 400);
  const reason = text(payload.reason ?? '', 1000, payload.action === 'approve' ? 0 : 10);
  let selected;
  if (payload.scope === 'product') selected = allVariants;
  else {
    if (
      !Array.isArray(payload.variants) ||
      !payload.variants.length ||
      payload.variants.length > 100
    )
      throw new CommerceError('invalid_variants', 'Select 1–100 variants.', 400);
    const ids = new Set();
    selected = payload.variants.map((entry) => {
      const v = allVariants.find((v) => v.cj_variant_id === entry.variantId);
      if (!v || ids.has(entry.variantId))
        throw new CommerceError('invalid_variant', 'Invalid or duplicate variant selection.', 400);
      ids.add(entry.variantId);
      return { ...v, expectedVersion: version(entry.expectedVersion) };
    });
  }
  if (!selected.length || selected.length > 100)
    throw new CommerceError('invalid_variants', 'This action supports 1–100 variants.', 400);
  // Full-product decisions also include per-variant versions sent by the UI.
  if (payload.scope === 'product') {
    if (!Array.isArray(payload.variants) || payload.variants.length !== selected.length)
      throw new CommerceError(
        'invalid_variants',
        'Reload all variant versions before a product decision.',
        400
      );
    selected = selected.map((v) => ({
      ...v,
      expectedVersion: version(
        payload.variants.find((i) => i.variantId === v.cj_variant_id)?.expectedVersion
      )
    }));
  }
  if (payload.action === 'approve') {
    const checks = await productShippingChecks(env.DB, p);
    for (const v of selected) {
      const checked = await approvalIssues(
        env.DB,
        p,
        v,
        policyState.policy,
        checks.filter((c) => c.variant_id === v.id)
      );
      if (checked.issues.length)
        throw new CommerceError('approval_blocked', checked.issues.join(' '), 409);
      v.shippingCheck = checked.shipping;
    }
  }
  const state = { approve: 'approved', reject: 'rejected', disable: 'disabled' }[payload.action];
  await commit(
    env.DB,
    p,
    payload.expectedVersion,
    selected,
    policyState.revision,
    actor,
    payload.scope + '_' + state,
    reason || 'Explicit administrative approval',
    ({ condition, mutation }) => {
      const statements = [
        env.DB.prepare(
          `UPDATE cj_variants SET active=?,review_state=?,review_reason=?,review_version=review_version+1,
      approved_review_version=CASE WHEN ?=1 THEN review_version+1 ELSE NULL END,last_admin_mutation=?
      WHERE product_id=? AND id IN(SELECT value FROM json_each(?)) AND ${condition}`
        ).bind(
          payload.action === 'approve' ? 1 : 0,
          state,
          reason || null,
          payload.action === 'approve' ? 1 : 0,
          mutation,
          p.id,
          JSON.stringify(selected.map((v) => v.id)),
          mutation
        )
      ];
      if (payload.scope === 'product' || payload.action === 'approve')
        statements.push(
          env.DB.prepare(
            `UPDATE cj_products SET active=?,review_state=?,review_reason=?,review_version=review_version+1,last_admin_mutation=? WHERE id=? AND ${condition}`
          ).bind(
            payload.action === 'approve' ? 1 : 0,
            state,
            reason || null,
            mutation,
            p.id,
            mutation
          )
        );
      else statements.push(touchProduct(env.DB, p, condition, mutation));
      return statements;
    }
  );
}
export async function savePolicy(env, actor, payload, current) {
  const reason = text(payload.reason, 1000, 20);
  const policy = pricingPolicy({
    RETAIL_PRICING_POLICY: JSON.stringify({
      ...payload.policy,
      version: 'policy-' + crypto.randomUUID().replaceAll('-', '').slice(0, 24)
    })
  });
  const mutation = crypto.randomUUID(),
    now = Date.now(),
    condition = 'EXISTS(SELECT 1 FROM admin_pricing_policy WHERE id=1 AND last_admin_mutation=?)';
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE admin_pricing_policy SET policy_json=?,revision=revision+1,last_admin_mutation=?,updated_ms=? WHERE id=1 AND revision=?`
    ).bind(JSON.stringify(policy), mutation, now, version(payload.expectedRevision)),
    env.DB.prepare(
      `UPDATE cj_variants SET active=0,review_state=CASE WHEN fixture_only=1 THEN 'disabled' ELSE 'needs_verification' END,
      review_version=review_version+1,approved_review_version=NULL,retail_verified_at=NULL,pricing_exception_json=NULL WHERE ${condition}`
    ).bind(mutation),
    env.DB.prepare(
      `UPDATE cj_products SET active=0,review_state=CASE WHEN fixture_only=1 THEN 'disabled' ELSE 'needs_verification' END,
      review_version=review_version+1 WHERE ${condition}`
    ).bind(mutation),
    env.DB.prepare(
      `INSERT INTO admin_audit(id,actor_sub,actor_email,auth_source,action,before_json,after_json,reason,created_ms)
      SELECT ?,?,?,?,'pricing_policy_changed',?,?,?,? WHERE ${condition}`
    ).bind(
      crypto.randomUUID(),
      actor.sub,
      actor.email,
      actor.source,
      JSON.stringify(current.policy),
      JSON.stringify(policy),
      reason,
      now,
      mutation
    )
  ]);
  if (result[0].meta?.changes !== 1)
    throw new CommerceError(
      'edit_conflict',
      'The pricing policy changed. Reload before saving.',
      409
    );
}
