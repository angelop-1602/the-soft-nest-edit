/** Shared, server-only CJ read client. No order or payment endpoints. */
const BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const TOKEN_LEEWAY_MS = 15 * 60 * 1000;

export class SyncError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SyncError';
    this.code = code;
  }
}

function safeCode(value) {
  const code = String(value ?? 'unknown');
  return /^[A-Za-z0-9_-]{1,30}$/.test(code) ? code : 'unknown';
}

// SOFTNEST_CJ_RATE_LIMIT_V1
// CJ Free accounts may allow only one API request per second. Keep the importer
// deliberately conservative. This queue serializes calls within one Worker isolate;
// the existing D1 sync lock prevents overlapping import runs.
const CJ_MIN_INTERVAL_MS = 1350;
let cjNextRequestAt = 0;
let cjQueue = Promise.resolve();
const delayCJ = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reserveSharedSlot(db) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    const slot = await db
      .prepare(
        `UPDATE cj_service_gate SET next_request_ms=?
      WHERE id=1 AND next_request_ms<=? AND blocked_until_ms<=?`
      )
      .bind(now + CJ_MIN_INTERVAL_MS, now, now)
      .run();
    if (slot.meta?.changes === 1) return;
    const state = await db
      .prepare('SELECT next_request_ms,blocked_until_ms FROM cj_service_gate WHERE id=1')
      .first();
    if (!state || state.blocked_until_ms > Date.now()) throw new SyncError('CJ_RATE_LIMITED');
    // Account for timer/DB latency and another isolate reserving the preceding slot.
    await delayCJ(
      Math.max(5, Math.min(CJ_MIN_INTERVAL_MS + 20, state.next_request_ms - Date.now() + 5))
    );
  }
  throw new SyncError('CJ_RATE_LIMITED');
}

async function waitForCJSlot() {
  const previous = cjQueue;
  let release;
  cjQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const now = Date.now();
    const start = Math.max(now, cjNextRequestAt);
    cjNextRequestAt = start + CJ_MIN_INTERVAL_MS;
    const wait = start - now;
    if (wait > 0) await delayCJ(wait);
  } finally {
    release();
  }
}

// HTTP 429 means EITHER too many calls or no remaining API points.
// We never log/return full CJ responses, API keys, tokens, or private usage data.
export function classifyCjRateLimit(status, payload) {
  const code = Number(payload?.code);
  const message = typeof payload?.message === 'string' ? payload.message : '';
  const knownRateCodes = [402, 406, 429, 1600200, 1600201, 16900500];
  if (status !== 429 && !knownRateCodes.includes(code)) return null;
  if (
    code === 1600201 ||
    code === 16900500 ||
    payload?.pointsInfo?.remaining === 0 ||
    /insufficient.{0,25}(?:api )?points|(?:api )?points.{0,20}exhausted|quota.{0,20}(?:used up|exceeded)/i.test(
      message
    )
  ) {
    return 'CJ_POINTS_EXHAUSTED';
  }
  return 'CJ_RATE_LIMITED';
}

export async function cjFetch(
  env,
  path,
  { method = 'GET', token = '', body = undefined, search = {} } = {}
) {
  // A closed allowlist makes supplier order creation/payment impossible here.
  const allowed = new Set([
    '/authentication/getAccessToken',
    '/authentication/refreshAccessToken',
    '/product/myProduct/query',
    '/product/variant/query',
    '/product/variant/queryByVid',
    '/product/stock/getInventoryByPid',
    '/logistic/freightCalculate'
  ]);
  if (
    !allowed.has(path) ||
    method !==
      (path.startsWith('/authentication/') || path.startsWith('/logistic/') ? 'POST' : 'GET')
  )
    throw new SyncError('CJ_ACTION_DISABLED');
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, String(value));
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitForCJSlot();
    await reserveSharedSlot(env.DB);
    let response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          ...(token ? { 'CJ-Access-Token': token } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw new SyncError('CJ_NETWORK_ERROR');
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      if (response.status !== 429 && !response.ok) {
        throw new SyncError(`CJ_HTTP_${response.status}`);
      }
      if (response.status !== 429) throw new SyncError('CJ_INVALID_JSON');
      payload = null; // An HTTP 429 can have an empty or non-JSON body.
    }
    const rateCode = classifyCjRateLimit(response.status, payload);
    if (rateCode === 'CJ_POINTS_EXHAUSTED') {
      // Waiting a few seconds cannot replenish the account's daily points.
      await env.DB.prepare(
        'UPDATE cj_service_gate SET blocked_until_ms=MAX(blocked_until_ms,?) WHERE id=1'
      )
        .bind(Date.now() + 60 * 60 * 1000)
        .run();
      throw new SyncError(rateCode);
    }
    if (rateCode === 'CJ_RATE_LIMITED') {
      const retryAfterSeconds = Number(response.headers.get('Retry-After'));
      const retryDate = Date.parse(response.headers.get('Retry-After') || '');
      const retryAfterMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : Math.max(0, (retryDate || 0) - Date.now());
      const cooldown = Math.max(2500 * (attempt + 1), retryAfterMs);
      await env.DB.prepare(
        'UPDATE cj_service_gate SET blocked_until_ms=MAX(blocked_until_ms,?) WHERE id=1'
      )
        .bind(Date.now() + Math.min(cooldown, 86400000))
        .run();
      if (attempt === 2 || cooldown > 15000) throw new SyncError(rateCode);
      await delayCJ(cooldown);
      continue;
    }
    if (!response.ok) throw new SyncError(`CJ_HTTP_${response.status}`);
    if (!payload || payload.result !== true || payload.code !== 200) {
      throw new SyncError(`CJ_CODE_${safeCode(payload?.code)}`);
    }
    return payload.data;
  }
  throw new SyncError('CJ_RATE_LIMITED');
}

function parsedExpiry(value, fallbackMs) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? timestamp : fallbackMs;
}

export async function getToken(env) {
  if (!env.CJDROPSHIPPING_API) throw new SyncError('CJ_API_KEY_NOT_SET');
  const now = Date.now();
  const cached = await env.DB.prepare(
    'SELECT access_token, access_expires_ms, refresh_token, refresh_expires_ms FROM cj_api_session WHERE id = 1'
  ).first();
  if (cached?.access_token && cached.access_expires_ms > now + TOKEN_LEEWAY_MS) {
    return cached.access_token;
  }
  const lock = await env.DB.prepare(
    `UPDATE cj_service_gate SET auth_lock_until_ms=?
    WHERE id=1 AND auth_lock_until_ms<=?`
  )
    .bind(now + 60000, now)
    .run();
  if (lock.meta?.changes !== 1) throw new SyncError('CJ_RATE_LIMITED');
  try {
    let data;
    if (cached?.refresh_token && cached.refresh_expires_ms > now + TOKEN_LEEWAY_MS) {
      try {
        data = await cjFetch(env, '/authentication/refreshAccessToken', {
          method: 'POST',
          body: { refreshToken: cached.refresh_token }
        });
      } catch (error) {
        // Re-authenticate if the previous refresh token is no longer valid.
        if (error instanceof SyncError && error.code.startsWith('CJ_CODE_')) data = undefined;
        else throw error;
      }
    }
    if (!data) {
      data = await cjFetch(env, '/authentication/getAccessToken', {
        method: 'POST',
        body: { apiKey: env.CJDROPSHIPPING_API }
      });
    }
    if (!data || typeof data.accessToken !== 'string' || !data.accessToken) {
      throw new SyncError('CJ_TOKEN_MISSING');
    }
    const accessExpires = parsedExpiry(data.accessTokenExpiryDate, now + 60 * 60 * 1000);
    const refreshExpires = parsedExpiry(data.refreshTokenExpiryDate, now + 24 * 60 * 60 * 1000);
    await env.DB.prepare(
      `INSERT INTO cj_api_session
       (id, access_token, access_expires_ms, refresh_token, refresh_expires_ms, updated_at)
       VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token,
       access_expires_ms=excluded.access_expires_ms, refresh_token=excluded.refresh_token,
       refresh_expires_ms=excluded.refresh_expires_ms, updated_at=CURRENT_TIMESTAMP`
    )
      .bind(data.accessToken, accessExpires, data.refreshToken || null, refreshExpires)
      .run();
    return data.accessToken;
  } finally {
    await env.DB.prepare('UPDATE cj_service_gate SET auth_lock_until_ms=0 WHERE id=1').run();
  }
}

/** Recover once from a revoked/expired token; never retry points exhaustion. */
export async function cjAuthorized(env, path, options = {}) {
  const token = await getToken(env);
  try {
    return await cjFetch(env, path, { ...options, token });
  } catch (error) {
    if (!['CJ_CODE_1600001', 'CJ_CODE_1600002', 'CJ_HTTP_401'].includes(error.code)) throw error;
    await env.DB.prepare(
      'UPDATE cj_api_session SET access_expires_ms=0 WHERE id=1 AND access_token=?'
    )
      .bind(token)
      .run();
    return cjFetch(env, path, { ...options, token: await getToken(env) });
  }
}
