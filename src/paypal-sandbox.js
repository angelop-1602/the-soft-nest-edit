/**
 * The Soft Nest Edit — sandbox-only PayPal checkout exercise.
 * This deliberately does NOT sell CJ products or create supplier orders.
 * All prices are server-owned and demo-only; all credentials stay in Worker secrets.
 */
const BASE = 'https://api-m.sandbox.paypal.com';
const CENTS = 100;
const MONEY = '1.00';
const ALLOWED_APPROVAL_HOSTS = new Set(['www.sandbox.paypal.com', 'sandbox.paypal.com']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYPAL_ID = /^[A-Za-z0-9]{8,64}$/;
const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
};

function reply(value, status = 200) {
  return Response.json(value, { status, headers: RESPONSE_HEADERS });
}

export function sandboxReady(env) {
  return env?.PAYPAL_MODE === 'sandbox'
    && env?.PAYPAL_SANDBOX_CHECKOUT_ENABLED === 'true'
    && Boolean(env?.PAYPAL_SANDBOX_CLIENT_ID)
    && Boolean(env?.PAYPAL_SANDBOX_CLIENT_SECRET)
    && Boolean(env?.DB);
}

export function validateApprovalUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password
      || !ALLOWED_APPROVAL_HOSTS.has(url.hostname) || url.port) return null;
    return url.href;
  } catch { return null; }
}

export function isCompletedCapture(data, checkoutId) {
  if (data?.status !== 'COMPLETED' || !Array.isArray(data.purchase_units)
    || data.purchase_units.length !== 1) return null;
  const unit = data.purchase_units[0];
  if (unit?.custom_id !== checkoutId || !Array.isArray(unit?.payments?.captures)
    || unit.payments.captures.length !== 1) return null;
  const capture = unit.payments.captures[0];
  if (capture?.status !== 'COMPLETED' || !PAYPAL_ID.test(String(capture.id || ''))
    || capture?.amount?.currency_code !== 'USD' || capture.amount.value !== MONEY) return null;
  return capture.id;
}

class SandboxError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function getAccessToken(env) {
  let res;
  try {
    res = await fetch(BASE + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${env.PAYPAL_SANDBOX_CLIENT_ID}:${env.PAYPAL_SANDBOX_CLIENT_SECRET}`),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(12000)
    });
  } catch { throw new SandboxError('PAYPAL_AUTH_NETWORK'); }
  if (!res.ok) throw new SandboxError('PAYPAL_AUTH_FAILED');
  let data;
  try { data = await res.json(); } catch { throw new SandboxError('PAYPAL_AUTH_INVALID'); }
  if (typeof data?.access_token !== 'string' || data.access_token.length < 8)
    throw new SandboxError('PAYPAL_AUTH_INVALID');
  return data.access_token;
}

export async function paypalRequest(env, path, payload, idempotencyKey, method='POST') {
  const token = await getAccessToken(env);
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Prefer: 'return=representation',
        ...(idempotencyKey ? { 'PayPal-Request-Id': idempotencyKey } : {})
      },
      ...(method==='POST' ? {body: JSON.stringify(payload)} : {}),
      signal: AbortSignal.timeout(15000)
    });
  } catch { throw new SandboxError('PAYPAL_NETWORK'); }
  if (!res.ok) throw new SandboxError('PAYPAL_API_FAILED');
  try { return await res.json(); } catch { throw new SandboxError('PAYPAL_RESPONSE_INVALID'); }
}

async function setStatus(db, id, status) {
  await db.prepare('UPDATE sandbox_checkouts SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(status, id).run();
}

async function createCheckout(request, env) {
  const id = crypto.randomUUID();
  const source = new URL(request.url);
  // Never trust a browser-supplied price, SKU, quantity, or callback URL.
  await env.DB.prepare(`INSERT INTO sandbox_checkouts
    (id, status, amount_cents, currency) VALUES (?, 'creating', ?, 'USD')`)
    .bind(id, CENTS).run();
  try {
    const checkoutUrl = new URL('/shop/checkout-test/', source.origin);
    checkoutUrl.searchParams.set('checkoutId', id);
    const returnUrl = new URL(checkoutUrl);
    returnUrl.searchParams.set('result', 'approved');
    const cancelUrl = new URL(checkoutUrl);
    cancelUrl.searchParams.set('result', 'canceled');
    const order = await paypalRequest(env, '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: id,
        custom_id: id,
        description: 'The Soft Nest Edit — Sandbox test only (no merchandise)',
        amount: { currency_code: 'USD', value: MONEY }
      }],
      payment_source: { paypal: { experience_context: {
        brand_name: 'The Soft Nest Edit — Sandbox Test',
        return_url: returnUrl.href,
        cancel_url: cancelUrl.href,
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW'
      } } }
    }, id + '-create');
    const orderId = String(order?.id || '');
    const links = Array.isArray(order?.links) ? order.links : [];
    const approvalUrl = validateApprovalUrl(
      links.find(link => link.rel === 'payer-action' || link.rel === 'approve')?.href
    );
    if (!PAYPAL_ID.test(orderId) || !approvalUrl) throw new SandboxError('PAYPAL_CREATE_INVALID');
    await env.DB.prepare(`UPDATE sandbox_checkouts
      SET paypal_order_id=?, status='created', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(orderId, id).run();
    return reply({ checkoutId: id, approvalUrl, environment: 'sandbox' }, 201);
  } catch (error) {
    await setStatus(env.DB, id, 'needs_review');
    return reply({ error: 'Unable to start a sandbox checkout. Check your PayPal sandbox setup.',
      code: error instanceof SandboxError ? error.code : 'SANDBOX_CREATE_FAILED' }, 502);
  }
}

async function readSmallJson(request) {
  const raw = await request.text();
  if (raw.length > 1024) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function captureCheckout(request, env) {
  const data = await readSmallJson(request);
  const checkoutId = data?.checkoutId;
  if (typeof checkoutId !== 'string' || !UUID.test(checkoutId))
    return reply({ error: 'Invalid checkout ID' }, 400);
  const existing = await env.DB.prepare(`SELECT id, status, paypal_order_id
    FROM sandbox_checkouts WHERE id=?`).bind(checkoutId).first();
  if (!existing) return reply({ error: 'Unknown checkout' }, 404);
  if (existing.status === 'paid') return reply({ checkoutId, status: 'paid', environment: 'sandbox' });
  if (existing.status !== 'created' || !PAYPAL_ID.test(String(existing.paypal_order_id || '')))
    return reply({ checkoutId, status: existing.status, error: 'This checkout cannot be captured automatically.' }, 409);
  const claim = await env.DB.prepare(`UPDATE sandbox_checkouts
    SET status='capturing', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='created'`)
    .bind(checkoutId).run();
  if (claim.meta?.changes !== 1) return reply({ error: 'Capture is already processing' }, 409);
  try {
    const result = await paypalRequest(env,
      `/v2/checkout/orders/${existing.paypal_order_id}/capture`, {}, checkoutId + '-capture');
    if (result?.id !== existing.paypal_order_id) throw new SandboxError('PAYPAL_ORDER_MISMATCH');
    const captureId = isCompletedCapture(result, checkoutId);
    if (!captureId) throw new SandboxError('PAYPAL_CAPTURE_NOT_VERIFIED');
    await env.DB.prepare(`UPDATE sandbox_checkouts SET
      status='paid', paypal_capture_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='capturing'`)
      .bind(captureId, checkoutId).run();
    return reply({ checkoutId, status: 'paid', environment: 'sandbox', message: 'Sandbox payment verified' });
  } catch (error) {
    // An interrupted PayPal call can leave an ambiguous result. Do NOT create
    // another capture automatically; reconcile it with PayPal before retrying.
    await setStatus(env.DB, checkoutId, 'needs_review');
    return reply({ checkoutId, status: 'needs_review',
      error: 'PayPal capture could not be verified. Do not repeat payment; inspect sandbox activity.',
      code: error instanceof SandboxError ? error.code : 'SANDBOX_CAPTURE_FAILED' }, 502);
  }
}

export async function handleSandboxPaypal(request, env, route) {
  const path = new URL(request.url);
  if (!['config', 'create', 'capture', 'status'].includes(route)) return reply({ error: 'Not found' }, 404);
  const expectedMethod = ['config', 'status'].includes(route) ? 'GET' : 'POST';
  if (request.method !== expectedMethod) return reply({ error: 'Method not allowed' }, 405);
  if (!sandboxReady(env)) return reply({ error: 'Sandbox checkout is disabled or not configured' }, 503);
  if (expectedMethod === 'POST') {
    // Strict same-origin policy for all state-changing endpoints.
    if (request.headers.get('Origin') !== path.origin)
      return reply({ error: 'Origin rejected' }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || ''))
      return reply({ error: 'JSON required' }, 415);
  }
  try {
    if (route === 'config') return reply({ environment: 'sandbox', testAmountUsd: MONEY,
      demoCheckoutEnabled: true, liveCheckoutEnabled: false, cjFulfillmentEnabled: false });
    if (route === 'create') return await createCheckout(request, env);
    if (route === 'capture') return await captureCheckout(request, env);
    const checkoutId = path.searchParams.get('checkoutId');
    if (!UUID.test(checkoutId || '')) return reply({ error: 'Invalid checkout ID' }, 400);
    const row = await env.DB.prepare('SELECT status FROM sandbox_checkouts WHERE id=?')
      .bind(checkoutId).first();
    return row ? reply({ checkoutId, status: row.status, environment: 'sandbox' })
      : reply({ error: 'Unknown checkout' }, 404);
  } catch {
    return reply({ error: 'Sandbox backend unavailable' }, 503);
  }
}
