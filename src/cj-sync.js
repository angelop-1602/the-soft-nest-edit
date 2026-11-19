/**
 * Read-only supplier importer for The Soft Nest Edit.
 * CJ My Products -> D1. No storefront publication, customer data, orders or payments.
 * Documentation: https://developers.cjdropshipping.com/en/api/api2/api/product.html
 */
const BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const PAGE_SIZE = 10;
const PAGES_PER_RUN = 2;
const MAX_VARIANTS = 100;
const TOKEN_LEEWAY_MS = 15 * 60 * 1000;

export class SyncError extends Error {
  constructor(code) { super(code); this.name = 'SyncError'; this.code = code; }
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
const delayCJ = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForCJSlot() {
  const previous = cjQueue;
  let release;
  cjQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    const now = Date.now();
    const start = Math.max(now, cjNextRequestAt);
    cjNextRequestAt = start + CJ_MIN_INTERVAL_MS;
    const wait = start - now;
    if (wait > 0) await delayCJ(wait);
  } finally { release(); }
}

// HTTP 429 means EITHER too many calls or no remaining API points.
// We never log/return full CJ responses, API keys, tokens, or private usage data.
export function classifyCjRateLimit(status, payload) {
  const code = Number(payload?.code);
  const message = typeof payload?.message === 'string' ? payload.message : '';
  const knownRateCodes = [402, 406, 429, 1600200, 1600201, 16900500];
  if (status !== 429 && !knownRateCodes.includes(code)) return null;
  if (code === 1600201 || code === 16900500 ||
    payload?.pointsInfo?.remaining === 0 ||
    /insufficient.{0,25}(?:api )?points|(?:api )?points.{0,20}exhausted|quota.{0,20}(?:used up|exceeded)/i.test(message)) {
    return 'CJ_POINTS_EXHAUSTED';
  }
  return 'CJ_RATE_LIMITED';
}

async function cjFetch(path, { method = 'GET', token = '', body = undefined, search = {} } = {}) {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, String(value));
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitForCJSlot();
    let response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers: {
          'Accept': 'application/json',
          ...(token ? { 'CJ-Access-Token': token } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000)
      });
    } catch { throw new SyncError('CJ_NETWORK_ERROR'); }
    let payload;
    try { payload = await response.json(); }
    catch {
      if (response.status !== 429 && !response.ok) {
        throw new SyncError(`CJ_HTTP_${response.status}`);
      }
      if (response.status !== 429) throw new SyncError('CJ_INVALID_JSON');
      payload = null; // An HTTP 429 can have an empty or non-JSON body.
    }
    const rateCode = classifyCjRateLimit(response.status, payload);
    if (rateCode === 'CJ_POINTS_EXHAUSTED') {
      // Waiting a few seconds cannot replenish the account's daily points.
      throw new SyncError(rateCode);
    }
    if (rateCode === 'CJ_RATE_LIMITED') {
      if (attempt === 2) throw new SyncError(rateCode);
      const retryAfterSeconds = Number(response.headers.get('Retry-After'));
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(15000, retryAfterSeconds * 1000) : 0;
      await delayCJ(Math.max(2500 * (attempt + 1), retryAfterMs));
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

async function getToken(env) {
  if (!env.CJDROPSHIPPING_API) throw new SyncError('CJ_API_KEY_NOT_SET');
  const now = Date.now();
  const cached = await env.DB.prepare(
    'SELECT access_token, access_expires_ms, refresh_token, refresh_expires_ms FROM cj_api_session WHERE id = 1'
  ).first();
  if (cached?.access_token && cached.access_expires_ms > now + TOKEN_LEEWAY_MS) {
    return cached.access_token;
  }

  let data;
  if (cached?.refresh_token && cached.refresh_expires_ms > now + TOKEN_LEEWAY_MS) {
    try {
      data = await cjFetch('/authentication/refreshAccessToken', {
        method: 'POST', body: { refreshToken: cached.refresh_token }
      });
    } catch (error) {
      // Re-authenticate if the previous refresh token is no longer valid.
      if (error instanceof SyncError && error.code.startsWith('CJ_CODE_')) data = undefined;
      else throw error;
    }
  }
  if (!data) {
    data = await cjFetch('/authentication/getAccessToken', {
      method: 'POST', body: { apiKey: env.CJDROPSHIPPING_API }
    });
  }
  if (!data || typeof data.accessToken !== 'string' || !data.accessToken) {
    throw new SyncError('CJ_TOKEN_MISSING');
  }
  const accessExpires = parsedExpiry(data.accessTokenExpiryDate, now + 60 * 60 * 1000);
  const refreshExpires = parsedExpiry(data.refreshTokenExpiryDate, now + 24 * 60 * 60 * 1000);
  await env.DB.prepare(`INSERT INTO cj_api_session
       (id, access_token, access_expires_ms, refresh_token, refresh_expires_ms, updated_at)
       VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token,
       access_expires_ms=excluded.access_expires_ms, refresh_token=excluded.refresh_token,
       refresh_expires_ms=excluded.refresh_expires_ms, updated_at=CURRENT_TIMESTAMP`)
    .bind(data.accessToken, accessExpires, data.refreshToken || null, refreshExpires).run();
  return data.accessToken;
}

export function priceToCents(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(str)) return null;
  const [whole, decimal = ''] = str.split('.');
  return Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
}

export function safeImage(url) {
  if (typeof url !== 'string') return null;
  try {
    const value = new URL(url);
    return value.protocol === 'https:' && !value.username && !value.password
      ? value.href.slice(0, 2048) : null;
  } catch { return null; }
}

export function normalizeProduct(item) {
  if (!item || typeof item !== 'object') return null;
  const pid = String(item.productId ?? '').trim();
  const title = String(item.nameEn ?? '').trim();
  if (!pid || !title || pid.length > 200 || title.length > 500) return null;
  return {
    id: `cj:${pid}`, pid, title, image: safeImage(item.bigImage),
    sku: String(item.sku ?? '').trim().slice(0, 200)
  };
}

export function normalizeVariant(item, pid) {
  if (!item || typeof item !== 'object') return null;
  const vid = String(item.vid ?? '').trim();
  if (!vid || vid.length > 200) return null;
  const label = String(item.variantKey || item.variantNameEn || '').trim().slice(0, 300);
  return {
    id: `cj-variant:${vid}`, pid, vid,
    sku: String(item.variantSku ?? '').trim().slice(0, 200),
    options: JSON.stringify({ label, image: safeImage(item.variantImage) }),
    cost: priceToCents(item.variantSellPrice)
  };
}

async function storeProduct(env, token, rawItem) {
  const p = normalizeProduct(rawItem);
  if (!p) throw new SyncError('CJ_BAD_PRODUCT_DATA');
  // Query exact variant IDs: 'My Product List' returns at most one default vid.
  const rawVariants = await cjFetch('/product/variant/query', {
    token, search: { pid: p.pid }
  });
  if (!Array.isArray(rawVariants) || rawVariants.length > MAX_VARIANTS) {
    throw new SyncError('CJ_VARIANTS_INVALID');
  }
  const variants = rawVariants.map(item => normalizeVariant(item, p.pid));
  if (!variants.length || variants.some(item => !item)) {
    throw new SyncError('CJ_VARIANTS_MISSING');
  }
  await env.DB.prepare(`INSERT INTO cj_products
    (id, cj_product_id, title, category, image_url, active, synced_at)
    VALUES (?, ?, ?, NULL, ?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(cj_product_id) DO UPDATE SET title=excluded.title,
    image_url=excluded.image_url, synced_at=CURRENT_TIMESTAMP`)
    .bind(p.id, p.pid, p.title, p.image).run();
  for (const v of variants) {
    await env.DB.prepare(`INSERT INTO cj_variants
      (id, product_id, cj_variant_id, cj_sku, options_json, supplier_cost_cents,
       retail_price_cents, inventory_quantity, active, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(cj_variant_id) DO UPDATE SET cj_sku=excluded.cj_sku,
      options_json=excluded.options_json, supplier_cost_cents=excluded.supplier_cost_cents,
      synced_at=CURRENT_TIMESTAMP`)
      .bind(v.id, p.id, v.vid, v.sku, v.options, v.cost).run();
  }
  return variants.length;
}

/** Incremental every-6h importer. All new records are deliberately inactive. */
export async function syncCjCatalog(env) {
  if (!env.DB) throw new SyncError('DB_MISSING');
  const runId = crypto.randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const lock = await env.DB.prepare(`UPDATE cj_sync_state SET
    lock_until=?, lock_token=?, last_run_at=CURRENT_TIMESTAMP, last_status='running'
    WHERE id=1 AND lock_until < ?`)
    .bind(nowSeconds + 8 * 60, runId, nowSeconds).run();
  if (lock.meta?.changes !== 1) return { status: 'already_running' };
  const snapshot = await env.DB.prepare('SELECT next_page FROM cj_sync_state WHERE id=1').first();
  const initialPage = Number(snapshot?.next_page) || 1;
  let nextPage = initialPage;
  let imported = 0;
  let pages = 0;
  let totalRecords = 0;
  let status = 'success';
  try {
    const token = await getToken(env);
    for (; pages < PAGES_PER_RUN; pages++) {
      const data = await cjFetch('/product/myProduct/query', {
        token, search: { pageNum: nextPage, pageSize: PAGE_SIZE }
      });
      if (!data || !Array.isArray(data.content)) {
        throw new SyncError('CJ_PAGE_INVALID');
      }
      // CJ docs list pageNumber in the response but do not explicitly specify
      // the My Products pagination parameters. Fail closed if ignored by CJ.
      if (data.pageNumber != null && Number(data.pageNumber) !== nextPage) {
        throw new SyncError('CJ_PAGINATION_UNSUPPORTED');
      }
      totalRecords = Math.max(0, Number(data.totalRecords) || 0);
      const totalPages = Math.max(1, Number(data.totalPages) || 1);
      if (nextPage > totalPages) { nextPage = 1; break; }
      if (!data.content.length && nextPage <= totalPages && totalRecords) {
        throw new SyncError('CJ_PAGE_EMPTY');
      }
      for (const item of data.content) {
        await storeProduct(env, token, item);
        imported++;
      }
      nextPage = nextPage >= totalPages ? 1 : nextPage + 1;
      if (nextPage === 1) break;
    }
    await env.DB.prepare(`UPDATE cj_sync_state SET
      next_page=?, total_records=?, last_success_at=CURRENT_TIMESTAMP,
      last_status=?, last_error_code=NULL, last_processed=?,
      lock_until=0, lock_token=NULL WHERE id=1 AND lock_token=?`)
      .bind(nextPage, totalRecords, status, imported, runId).run();
    return { status, imported, nextPage };
  } catch (error) {
    const code = error instanceof SyncError ? error.code : 'CJ_SYNC_INTERNAL_ERROR';
    await env.DB.prepare(`UPDATE cj_sync_state SET last_status='error',
      last_error_code=?, last_processed=?, lock_until=0, lock_token=NULL
      WHERE id=1 AND lock_token=?`).bind(code, imported, runId).run();
    // The status endpoint reports only a sanitized code, never raw CJ messages.
    return { status: 'error', errorCode: code, imported };
  }
}

export async function catalogStatus(db) {
  const state = await db.prepare(`SELECT next_page, total_records, last_run_at,
    last_success_at, last_status, last_error_code, last_processed
    FROM cj_sync_state WHERE id=1`).first();
  const totals = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM cj_products) AS products,
    (SELECT COUNT(*) FROM cj_variants) AS variants,
    (SELECT COUNT(*) FROM cj_products WHERE active = 1) AS approved_products`).first();
  return {
    integration: 'cj_catalog_import',
    status: state?.last_status || 'not_initialized',
    lastRun: state?.last_run_at || null,
    lastSuccess: state?.last_success_at || null,
    lastErrorCode: state?.last_error_code || null,
    importedLastRun: state?.last_processed || 0,
    nextPage: state?.next_page || 1,
    supplierRecords: state?.total_records || 0,
    storedProducts: totals?.products || 0,
    storedVariants: totals?.variants || 0,
    approvedProducts: totals?.approved_products || 0,
    checkoutEnabled: false
  };
}
