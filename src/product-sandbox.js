/** Local-only product Sandbox. No live host/credentials and no CJ order actions. */
import { paypalRequest, sandboxReady, validateApprovalUrl } from './paypal-sandbox.js';
import {
  CommerceError,
  UUID,
  localRequest,
  ownerHash,
  readJson,
  reply,
  publicError
} from './commerce-security.js';
import { validateQuote } from './cj-shipping.js';

const PAYPAL_ID = /^[A-Za-z0-9]{8,64}$/;
const money = (cents) => (cents / 100).toFixed(2);
const RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;
const LEASE_MS = 90000;
export const productSandboxReady = (request, env) =>
  localRequest(request) && env.PRODUCT_SANDBOX_CHECKOUT_ENABLED === 'true' && sandboxReady(env);

function verifyUnit(data, order) {
  if (
    data?.id !== order.paypal_order_id ||
    !Array.isArray(data.purchase_units) ||
    data.purchase_units.length !== 1
  )
    return null;
  const unit = data.purchase_units[0];
  if (
    unit.custom_id !== order.id ||
    unit.reference_id !== order.id ||
    unit.amount?.currency_code !== 'USD' ||
    unit.amount.value !== money(order.total_cents)
  )
    return null;
  return unit;
}
export function verifiedProductCapture(data, order) {
  const unit = verifyUnit(data, order);
  if (
    !unit ||
    data.status !== 'COMPLETED' ||
    !Array.isArray(unit.payments?.captures) ||
    unit.payments.captures.length !== 1
  )
    return null;
  const c = unit.payments.captures[0];
  if (
    c.status !== 'COMPLETED' ||
    !PAYPAL_ID.test(c.id || '') ||
    c.final_capture === false ||
    c.amount?.currency_code !== 'USD' ||
    c.amount.value !== money(order.total_cents)
  )
    return null;
  // Store only verification evidence, never a raw PayPal body containing payer data.
  return {
    id: c.id,
    status: 'COMPLETED',
    orderId: data.id,
    currency: 'USD',
    amountCents: order.total_cents
  };
}
const stateView = (row) => ({
  checkoutId: row.id,
  status: row.status,
  environment: 'sandbox',
  totalCents: row.total_cents,
  currency: 'USD',
  customerCheckoutEnabled: false,
  cjFulfillmentEnabled: false,
  ...(row.status === 'created' ? { approvalUrl: validateApprovalUrl(row.approval_url) } : {})
});
async function event(db, id, action, result) {
  await db
    .prepare(
      'INSERT INTO product_sandbox_events(id,order_id,action,result,created_ms) VALUES(?,?,?,?,?)'
    )
    .bind(crypto.randomUUID(), id, action, result, Date.now())
    .run();
}
async function transition(db, id, status, errorCode = null, operationToken = null) {
  const params = [status, errorCode, Date.now() + 20000, Date.now(), id];
  if (operationToken) params.push(operationToken);
  return db
    .prepare(
      `UPDATE product_sandbox_orders SET status=?,last_error_code=?,lease_until_ms=?,updated_ms=?
    WHERE id=? AND status NOT IN ('paid','needs_review')${operationToken ? ' AND operation_token=?' : ''}`
    )
    .bind(...params)
    .run();
}
async function ownedOrder(db, owner, id) {
  if (!UUID.test(id || ''))
    throw new CommerceError('invalid_checkout', 'Invalid Sandbox checkout reference.', 400);
  const row = await db
    .prepare('SELECT * FROM product_sandbox_orders WHERE id=? AND owner_hash=?')
    .bind(id, owner)
    .first();
  if (!row) throw new CommerceError('unknown_checkout', 'Unknown Sandbox checkout.', 404);
  return row;
}
async function create(request, env, owner, payload) {
  if (!UUID.test(payload?.quoteId || '') || !UUID.test(payload?.requestKey || ''))
    throw new CommerceError(
      'invalid_request',
      'A current shipping quote and request key are required.',
      400
    );
  let row = await env.DB.prepare(
    'SELECT * FROM product_sandbox_orders WHERE owner_hash=? AND request_key=?'
  )
    .bind(owner, payload.requestKey)
    .first();
  if (row && row.quote_id !== payload.quoteId)
    throw new CommerceError('request_conflict', 'This request key belongs to another estimate.');
  if (row?.status==='paid') return reply(stateView(row));
  if (row?.status==='created') {
    await validateQuote(env,owner,row.quote_id);
    return reply(stateView(row));
  }
  if (row && !['creating', 'create_retry'].includes(row.status))
    throw new CommerceError('checkout_processing', 'This checkout is already processing.');
  const quote = await validateQuote(env, owner, payload.quoteId, {
    live: true
  });
  if (!row) {
    const now = Date.now();
    const id = crypto.randomUUID();
    // UNIQUE quote_id also prevents two different request keys spending one quote.
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO product_sandbox_orders(id,owner_hash,request_key,quote_id,
      status,currency,subtotal_cents,shipping_cents,total_cents,snapshot_json,created_ms,updated_ms)
      VALUES(?,?,?,?,'creating','USD',?,?,?,?,?,?)`
    )
      .bind(
        id,
        owner,
        payload.requestKey,
        quote.id,
        quote.subtotal_cents,
        quote.shipping_cents,
        quote.total_cents,
        quote.snapshot_json,
        now,
        now
      )
      .run();
    if (inserted.meta?.changes !== 1)
      throw new CommerceError('checkout_exists', 'This estimate already has a Sandbox checkout.');
    row = await ownedOrder(env.DB, owner, id);
  }
  if (Date.now() - row.created_ms > RETRY_WINDOW_MS) {
    await transition(env.DB, row.id, 'needs_review', 'CREATE_RETRY_EXPIRED');
    throw new CommerceError(
      'needs_review',
      'This Sandbox checkout requires manual reconciliation.'
    );
  }
  const now = Date.now(),
    operationToken = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE product_sandbox_orders SET status='creating',lease_until_ms=?,operation_token=?,attempts=attempts+1
    WHERE id=? AND status IN ('creating','create_retry') AND lease_until_ms<=?`
  )
    .bind(now + LEASE_MS, operationToken, row.id, now)
    .run();
  if (claim.meta?.changes !== 1)
    throw new CommerceError('checkout_processing', 'Sandbox checkout is processing. Please wait.');
  try {
    const snapshot = JSON.parse(row.snapshot_json);
    const callback = new URL('/shop/cart-preview/', request.url);
    callback.searchParams.set('productCheckoutId', row.id);
    const approved = new URL(callback);
    approved.searchParams.set('result', 'approved');
    const canceled = new URL(callback);
    canceled.searchParams.set('result', 'canceled');
    const data = await paypalRequest(
      env,
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: row.id,
            custom_id: row.id,
            description:
              'The Soft Nest Edit: product Sandbox simulation, no merchandise or fulfillment',
            items: snapshot.lines.map((line) => ({
              name: ('Sandbox: ' + line.title).slice(0, 127),
              quantity: String(line.quantity),
              unit_amount: { currency_code: 'USD', value: money(line.unitPriceCents) }
            })),
            amount: {
              currency_code: 'USD',
              value: money(row.total_cents),
              breakdown: {
                item_total: {
                  currency_code: 'USD',
                  value: money(row.subtotal_cents)
                },
                shipping: {
                  currency_code: 'USD',
                  value: money(row.shipping_cents)
                }
              }
            }
          }
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'The Soft Nest Edit Sandbox',
              return_url: approved.href,
              cancel_url: canceled.href,
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW'
            }
          }
        }
      },
      row.id + '-create'
    );
    const approvalUrl = validateApprovalUrl(
      data?.links?.find((l) => ['payer-action', 'approve'].includes(l.rel))?.href
    );
    if (
      !PAYPAL_ID.test(data?.id || '') ||
      !approvalUrl ||
      !verifyUnit(data, { ...row, paypal_order_id: data.id })
    ) {
      await transition(env.DB, row.id, 'needs_review', 'CREATE_IDENTITY_MISMATCH', operationToken);
      throw new CommerceError('needs_review', 'PayPal Sandbox order could not be verified.');
    }
    const saved = await env.DB.prepare(
      `UPDATE product_sandbox_orders SET status='created',paypal_order_id=?,approval_url=?,
      lease_until_ms=0,last_error_code=NULL,updated_ms=? WHERE id=? AND status='creating' AND operation_token=?`
    )
      .bind(data.id, approvalUrl, Date.now(), row.id, operationToken)
      .run();
    if (saved.meta?.changes !== 1)
      throw new CommerceError(
        'checkout_processing',
        'Another request is reconciling this checkout.'
      );
    await event(env.DB, row.id, 'create', 'created');
    return reply(stateView({ ...row, status: 'created', approval_url: approvalUrl }), 201);
  } catch (error) {
    if (error instanceof CommerceError) throw error;
    await transition(env.DB, row.id, 'create_retry', 'SANDBOX_CREATE_UNCERTAIN', operationToken);
    await event(env.DB, row.id, 'create', 'retry_required');
    throw new CommerceError(
      'create_retry',
      'Sandbox response was interrupted. Retry this same checkout after 20 seconds.',
      502
    );
  }
}
async function capture(env, owner, payload) {
  const row = await ownedOrder(env.DB, owner, payload?.checkoutId);
  if (row.status === 'paid') return reply(stateView(row));
  if (
    !['created', 'capturing', 'capture_retry'].includes(row.status) ||
    !PAYPAL_ID.test(row.paypal_order_id || '')
  )
    throw new CommerceError(
      'capture_unavailable',
      'This Sandbox checkout cannot be captured automatically.'
    );
  const now = Date.now(),
    operationToken = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE product_sandbox_orders SET status='capturing',lease_until_ms=?,operation_token=?,attempts=attempts+1
    WHERE id=? AND status IN ('created','capturing','capture_retry') AND lease_until_ms<=?`
  )
    .bind(now + LEASE_MS, operationToken, row.id, now)
    .run();
  if (claim.meta?.changes !== 1)
    throw new CommerceError('capture_processing', 'Sandbox capture is processing. Please wait.');
  try {
    // Always reconcile first. A timed-out POST may already have completed.
    let data = await paypalRequest(
      env,
      `/v2/checkout/orders/${row.paypal_order_id}`,
      undefined,
      undefined,
      'GET'
    );
    if (!verifyUnit(data, row))
      throw new CommerceError(
        'payment_mismatch',
        'Sandbox order identity or amount did not match.'
      );
    if (data.status !== 'COMPLETED') {
      if (Date.now() - row.created_ms > RETRY_WINDOW_MS)
        throw new CommerceError(
          'needs_review',
          'Sandbox retry window expired; manual reconciliation required.'
        );
      if (data.status !== 'APPROVED')
        throw new CommerceError(
          'not_approved',
          'Approve this order in PayPal Sandbox before capture.'
        );
      await validateQuote(env, owner, row.quote_id, { live: true });
      data = await paypalRequest(
        env,
        `/v2/checkout/orders/${row.paypal_order_id}/capture`,
        {},
        row.id + '-capture'
      );
    }
    const evidence = verifiedProductCapture(data, row);
    if (!evidence)
      throw new CommerceError(
        'payment_mismatch',
        'Sandbox payment amount, currency or identity did not match.'
      );
    const saved = await env.DB.batch([
      env.DB.prepare(
        `UPDATE product_sandbox_orders SET status='paid',paypal_capture_id=?,capture_json=?,
        lease_until_ms=0,last_error_code=NULL,updated_ms=? WHERE id=? AND status='capturing' AND operation_token=?`
      ).bind(evidence.id, JSON.stringify(evidence), Date.now(), row.id, operationToken),
      env.DB.prepare(
        `INSERT INTO product_sandbox_events(id,order_id,action,result,created_ms)
        SELECT ?,id,'capture','paid',? FROM product_sandbox_orders WHERE id=? AND status='paid' AND operation_token=?`
      ).bind(crypto.randomUUID(), Date.now(), row.id, operationToken)
    ]);
    if (saved[0].meta?.changes !== 1)
      throw new CommerceError(
        'capture_processing',
        'Another request is reconciling this checkout.'
      );
    return reply(stateView({ ...row, status: 'paid' }));
  } catch (error) {
    const isMismatch =
      error instanceof CommerceError && ['payment_mismatch', 'needs_review'].includes(error.code);
    const status = isMismatch ? 'needs_review' : 'capture_retry';
    await transition(
      env.DB,
      row.id,
      status,
      isMismatch ? 'SANDBOX_VERIFICATION_FAILED' : 'SANDBOX_CAPTURE_UNCERTAIN',
      operationToken
    );
    await event(env.DB, row.id, 'capture', status);
    if (error instanceof CommerceError) throw error;
    throw new CommerceError(
      'capture_retry',
      'Sandbox capture is awaiting verification. Retry verification after 20 seconds; do not start another payment.',
      502
    );
  }
}
export async function handleProductSandbox(request, env, route) {
  if (!['config', 'create', 'capture', 'status'].includes(route))
    return reply({ error: 'Not found' }, 404);
  const method = ['config', 'status'].includes(route) ? 'GET' : 'POST';
  if (request.method !== method) return reply({ error: 'Method not allowed' }, 405);
  if (route === 'config')
    return reply({
      environment: 'sandbox',
      enabled: productSandboxReady(request, env),
      localOnly: true,
      customerCheckoutEnabled: false,
      cjFulfillmentEnabled: false
    });
  if (!productSandboxReady(request, env))
    return reply(
      {
        error: 'Product Sandbox checkout is disabled. Local development only.'
      },
      503
    );
  try {
    const payload = method === 'POST' ? await readJson(request) : null;
    const owner = await ownerHash(request);
    if (route === 'create') return await create(request, env, owner, payload);
    if (route === 'capture') return await capture(env, owner, payload);
    return reply(
      stateView(
        await ownedOrder(env.DB, owner, new URL(request.url).searchParams.get('checkoutId'))
      )
    );
  } catch (error) {
    return publicError(error);
  }
}
