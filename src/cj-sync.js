import { cjFetch, getToken, SyncError } from './cj-client.js';
export { classifyCjRateLimit, SyncError } from './cj-client.js';
/**
 * Read-only supplier importer for The Soft Nest Edit.
 * CJ My Products -> D1. No storefront publication, customer data, orders or payments.
 * Documentation: https://developers.cjdropshipping.com/en/api/api2/api/product.html
 */
const PAGE_SIZE = 10;
const PAGES_PER_RUN = 2;
const MAX_VARIANTS = 100;

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
      ? value.href.slice(0, 2048)
      : null;
  } catch {
    return null;
  }
}

export function normalizeProduct(item) {
  if (!item || typeof item !== 'object') return null;
  const pid = String(item.productId ?? '').trim();
  const title = String(item.nameEn ?? '').trim();
  if (!pid || !title || pid.length > 200 || title.length > 500) return null;
  return {
    id: `cj:${pid}`,
    pid,
    title,
    image: safeImage(item.bigImage),
    sku: String(item.sku ?? '')
      .trim()
      .slice(0, 200)
  };
}

export function normalizeVariant(item, pid) {
  if (!item || typeof item !== 'object') return null;
  const vid = String(item.vid ?? '').trim();
  if (!vid || vid.length > 200) return null;
  const label = String(item.variantKey || item.variantNameEn || '')
    .trim()
    .slice(0, 300);
  return {
    id: `cj-variant:${vid}`,
    pid,
    vid,
    sku: String(item.variantSku ?? '')
      .trim()
      .slice(0, 200),
    options: JSON.stringify({ label, image: safeImage(item.variantImage) }),
    cost: priceToCents(item.variantSellPrice)
  };
}

async function storeProduct(env, token, rawItem) {
  const p = normalizeProduct(rawItem);
  if (!p) throw new SyncError('CJ_BAD_PRODUCT_DATA');
  // Query exact variant IDs: 'My Product List' returns at most one default vid.
  const rawVariants = await cjFetch(env, '/product/variant/query', {
    token,
    search: { pid: p.pid }
  });
  if (!Array.isArray(rawVariants) || rawVariants.length > MAX_VARIANTS) {
    throw new SyncError('CJ_VARIANTS_INVALID');
  }
  const variants = rawVariants.map((item) => normalizeVariant(item, p.pid));
  if (!variants.length || variants.some((item) => !item)) {
    throw new SyncError('CJ_VARIANTS_MISSING');
  }
  await env.DB.prepare(
    `INSERT INTO cj_products
    (id, cj_product_id, title, category, image_url, active, synced_at)
    VALUES (?, ?, ?, NULL, ?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(cj_product_id) DO UPDATE SET title=excluded.title,
    image_url=excluded.image_url, synced_at=CURRENT_TIMESTAMP`
  )
    .bind(p.id, p.pid, p.title, p.image)
    .run();
  for (const v of variants) {
    await env.DB.prepare(
      `INSERT INTO cj_variants
      (id, product_id, cj_variant_id, cj_sku, options_json, supplier_cost_cents,
       retail_price_cents, inventory_quantity, active, synced_at, supplier_cost_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(cj_variant_id) DO UPDATE SET cj_sku=excluded.cj_sku,
      options_json=excluded.options_json, supplier_cost_cents=excluded.supplier_cost_cents,
      synced_at=CURRENT_TIMESTAMP, supplier_cost_verified_at=excluded.supplier_cost_verified_at`
    )
      .bind(
        v.id,
        p.id,
        v.vid,
        v.sku,
        v.options,
        v.cost,
        v.cost === null ? null : new Date().toISOString()
      )
      .run();
  }
  return variants.length;
}

/** Incremental every-6h importer. All new records are deliberately inactive. */
export async function syncCjCatalog(env) {
  if (!env.DB) throw new SyncError('DB_MISSING');
  const runId = crypto.randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const lock = await env.DB.prepare(
    `UPDATE cj_sync_state SET
    lock_until=?, lock_token=?, last_run_at=CURRENT_TIMESTAMP, last_status='running'
    WHERE id=1 AND lock_until < ?`
  )
    .bind(nowSeconds + 8 * 60, runId, nowSeconds)
    .run();
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
      const data = await cjFetch(env, '/product/myProduct/query', {
        token,
        search: { pageNum: nextPage, pageSize: PAGE_SIZE }
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
      if (nextPage > totalPages) {
        nextPage = 1;
        break;
      }
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
    await env.DB.prepare(
      `UPDATE cj_sync_state SET
      next_page=?, total_records=?, last_success_at=CURRENT_TIMESTAMP,
      last_status=?, last_error_code=NULL, last_processed=?,
      lock_until=0, lock_token=NULL WHERE id=1 AND lock_token=?`
    )
      .bind(nextPage, totalRecords, status, imported, runId)
      .run();
    return { status, imported, nextPage };
  } catch (error) {
    const code = error instanceof SyncError ? error.code : 'CJ_SYNC_INTERNAL_ERROR';
    await env.DB.prepare(
      `UPDATE cj_sync_state SET last_status='error',
      last_error_code=?, last_processed=?, lock_until=0, lock_token=NULL
      WHERE id=1 AND lock_token=?`
    )
      .bind(code, imported, runId)
      .run();
    // The status endpoint reports only a sanitized code, never raw CJ messages.
    return { status: 'error', errorCode: code, imported };
  }
}

export async function catalogStatus(db) {
  const state = await db
    .prepare(
      `SELECT next_page, total_records, last_run_at,
    last_success_at, last_status, last_error_code, last_processed
    FROM cj_sync_state WHERE id=1`
    )
    .first();
  const totals = await db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM cj_products) AS products,
    (SELECT COUNT(*) FROM cj_variants) AS variants,
    (SELECT COUNT(*) FROM cj_products WHERE active = 1) AS approved_products`
    )
    .first();
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
