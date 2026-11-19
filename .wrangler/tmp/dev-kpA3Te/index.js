var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/cj-sync.js
var BASE = "https://developers.cjdropshipping.com/api2.0/v1";
var PAGE_SIZE = 10;
var PAGES_PER_RUN = 2;
var MAX_VARIANTS = 100;
var TOKEN_LEEWAY_MS = 15 * 60 * 1e3;
var SyncError = class extends Error {
  static {
    __name(this, "SyncError");
  }
  constructor(code) {
    super(code);
    this.name = "SyncError";
    this.code = code;
  }
};
function safeCode(value) {
  const code = String(value ?? "unknown");
  return /^[A-Za-z0-9_-]{1,30}$/.test(code) ? code : "unknown";
}
__name(safeCode, "safeCode");
async function cjFetch(path, { method = "GET", token = "", body = void 0, search = {} } = {}) {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers: {
        "Accept": "application/json",
        ...token ? { "CJ-Access-Token": token } : {},
        ...body !== void 0 ? { "Content-Type": "application/json" } : {}
      },
      ...body !== void 0 ? { body: JSON.stringify(body) } : {},
      signal: AbortSignal.timeout(15e3)
    });
  } catch {
    throw new SyncError("CJ_NETWORK_ERROR");
  }
  if (!response.ok) throw new SyncError(`CJ_HTTP_${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new SyncError("CJ_INVALID_JSON");
  }
  if (!payload || payload.result !== true || payload.code !== 200) {
    throw new SyncError(`CJ_CODE_${safeCode(payload?.code)}`);
  }
  return payload.data;
}
__name(cjFetch, "cjFetch");
function parsedExpiry(value, fallbackMs) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : fallbackMs;
}
__name(parsedExpiry, "parsedExpiry");
async function getToken(env) {
  if (!env.CJDROPSHIPPING_API) throw new SyncError("CJ_API_KEY_NOT_SET");
  const now = Date.now();
  const cached = await env.DB.prepare(
    "SELECT access_token, access_expires_ms, refresh_token, refresh_expires_ms FROM cj_api_session WHERE id = 1"
  ).first();
  if (cached?.access_token && cached.access_expires_ms > now + TOKEN_LEEWAY_MS) {
    return cached.access_token;
  }
  let data;
  if (cached?.refresh_token && cached.refresh_expires_ms > now + TOKEN_LEEWAY_MS) {
    try {
      data = await cjFetch("/authentication/refreshAccessToken", {
        method: "POST",
        body: { refreshToken: cached.refresh_token }
      });
    } catch (error) {
      if (error instanceof SyncError && error.code.startsWith("CJ_CODE_")) data = void 0;
      else throw error;
    }
  }
  if (!data) {
    data = await cjFetch("/authentication/getAccessToken", {
      method: "POST",
      body: { apiKey: env.CJDROPSHIPPING_API }
    });
  }
  if (!data || typeof data.accessToken !== "string" || !data.accessToken) {
    throw new SyncError("CJ_TOKEN_MISSING");
  }
  const accessExpires = parsedExpiry(data.accessTokenExpiryDate, now + 60 * 60 * 1e3);
  const refreshExpires = parsedExpiry(data.refreshTokenExpiryDate, now + 24 * 60 * 60 * 1e3);
  await env.DB.prepare(`INSERT INTO cj_api_session
       (id, access_token, access_expires_ms, refresh_token, refresh_expires_ms, updated_at)
       VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token,
       access_expires_ms=excluded.access_expires_ms, refresh_token=excluded.refresh_token,
       refresh_expires_ms=excluded.refresh_expires_ms, updated_at=CURRENT_TIMESTAMP`).bind(data.accessToken, accessExpires, data.refreshToken || null, refreshExpires).run();
  return data.accessToken;
}
__name(getToken, "getToken");
function priceToCents(value) {
  if (value === null || value === void 0) return null;
  const str = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(str)) return null;
  const [whole, decimal = ""] = str.split(".");
  return Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
}
__name(priceToCents, "priceToCents");
function safeImage(url) {
  if (typeof url !== "string") return null;
  try {
    const value = new URL(url);
    return value.protocol === "https:" && !value.username && !value.password ? value.href.slice(0, 2048) : null;
  } catch {
    return null;
  }
}
__name(safeImage, "safeImage");
function normalizeProduct(item) {
  if (!item || typeof item !== "object") return null;
  const pid = String(item.productId ?? "").trim();
  const title = String(item.nameEn ?? "").trim();
  if (!pid || !title || pid.length > 200 || title.length > 500) return null;
  return {
    id: `cj:${pid}`,
    pid,
    title,
    image: safeImage(item.bigImage),
    sku: String(item.sku ?? "").trim().slice(0, 200)
  };
}
__name(normalizeProduct, "normalizeProduct");
function normalizeVariant(item, pid) {
  if (!item || typeof item !== "object") return null;
  const vid = String(item.vid ?? "").trim();
  if (!vid || vid.length > 200) return null;
  const label = String(item.variantKey || item.variantNameEn || "").trim().slice(0, 300);
  return {
    id: `cj-variant:${vid}`,
    pid,
    vid,
    sku: String(item.variantSku ?? "").trim().slice(0, 200),
    options: JSON.stringify({ label, image: safeImage(item.variantImage) }),
    cost: priceToCents(item.variantSellPrice)
  };
}
__name(normalizeVariant, "normalizeVariant");
async function storeProduct(env, token, rawItem) {
  const p = normalizeProduct(rawItem);
  if (!p) throw new SyncError("CJ_BAD_PRODUCT_DATA");
  const rawVariants = await cjFetch("/product/variant/query", {
    token,
    search: { pid: p.pid }
  });
  if (!Array.isArray(rawVariants) || rawVariants.length > MAX_VARIANTS) {
    throw new SyncError("CJ_VARIANTS_INVALID");
  }
  const variants = rawVariants.map((item) => normalizeVariant(item, p.pid));
  if (!variants.length || variants.some((item) => !item)) {
    throw new SyncError("CJ_VARIANTS_MISSING");
  }
  await env.DB.prepare(`INSERT INTO cj_products
    (id, cj_product_id, title, category, image_url, active, synced_at)
    VALUES (?, ?, ?, NULL, ?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(cj_product_id) DO UPDATE SET title=excluded.title,
    image_url=excluded.image_url, synced_at=CURRENT_TIMESTAMP`).bind(p.id, p.pid, p.title, p.image).run();
  for (const v of variants) {
    await env.DB.prepare(`INSERT INTO cj_variants
      (id, product_id, cj_variant_id, cj_sku, options_json, supplier_cost_cents,
       retail_price_cents, inventory_quantity, active, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(cj_variant_id) DO UPDATE SET cj_sku=excluded.cj_sku,
      options_json=excluded.options_json, supplier_cost_cents=excluded.supplier_cost_cents,
      synced_at=CURRENT_TIMESTAMP`).bind(v.id, p.id, v.vid, v.sku, v.options, v.cost).run();
  }
  return variants.length;
}
__name(storeProduct, "storeProduct");
async function syncCjCatalog(env) {
  if (!env.DB) throw new SyncError("DB_MISSING");
  const runId = crypto.randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1e3);
  const lock = await env.DB.prepare(`UPDATE cj_sync_state SET
    lock_until=?, lock_token=?, last_run_at=CURRENT_TIMESTAMP, last_status='running'
    WHERE id=1 AND lock_until < ?`).bind(nowSeconds + 8 * 60, runId, nowSeconds).run();
  if (lock.meta?.changes !== 1) return { status: "already_running" };
  const snapshot = await env.DB.prepare("SELECT next_page FROM cj_sync_state WHERE id=1").first();
  const initialPage = Number(snapshot?.next_page) || 1;
  let nextPage = initialPage;
  let imported = 0;
  let pages = 0;
  let totalRecords = 0;
  let status = "success";
  try {
    const token = await getToken(env);
    for (; pages < PAGES_PER_RUN; pages++) {
      const data = await cjFetch("/product/myProduct/query", {
        token,
        search: { pageNum: nextPage, pageSize: PAGE_SIZE }
      });
      if (!data || !Array.isArray(data.content)) {
        throw new SyncError("CJ_PAGE_INVALID");
      }
      if (data.pageNumber != null && Number(data.pageNumber) !== nextPage) {
        throw new SyncError("CJ_PAGINATION_UNSUPPORTED");
      }
      totalRecords = Math.max(0, Number(data.totalRecords) || 0);
      const totalPages = Math.max(1, Number(data.totalPages) || 1);
      if (nextPage > totalPages) {
        nextPage = 1;
        break;
      }
      if (!data.content.length && nextPage <= totalPages && totalRecords) {
        throw new SyncError("CJ_PAGE_EMPTY");
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
      lock_until=0, lock_token=NULL WHERE id=1 AND lock_token=?`).bind(nextPage, totalRecords, status, imported, runId).run();
    return { status, imported, nextPage };
  } catch (error) {
    const code = error instanceof SyncError ? error.code : "CJ_SYNC_INTERNAL_ERROR";
    await env.DB.prepare(`UPDATE cj_sync_state SET last_status='error',
      last_error_code=?, last_processed=?, lock_until=0, lock_token=NULL
      WHERE id=1 AND lock_token=?`).bind(code, imported, runId).run();
    return { status: "error", errorCode: code, imported };
  }
}
__name(syncCjCatalog, "syncCjCatalog");
async function catalogStatus(db) {
  const state = await db.prepare(`SELECT next_page, total_records, last_run_at,
    last_success_at, last_status, last_error_code, last_processed
    FROM cj_sync_state WHERE id=1`).first();
  const totals = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM cj_products) AS products,
    (SELECT COUNT(*) FROM cj_variants) AS variants,
    (SELECT COUNT(*) FROM cj_products WHERE active = 1) AS approved_products`).first();
  return {
    integration: "cj_catalog_import",
    status: state?.last_status || "not_initialized",
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
__name(catalogStatus, "catalogStatus");

// src/catalog-preview.js
var PAGE_SIZE2 = 16;
var MAX_PAGE = 100;
function parsePreviewPage(raw) {
  if (raw === null) return 1;
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_PAGE ? n : null;
}
__name(parsePreviewPage, "parsePreviewPage");
function safeVariantOptions(raw) {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      label: typeof value?.label === "string" ? value.label.slice(0, 160) : "",
      image: safeImage(value?.image) || null
    };
  } catch {
    return { label: "", image: null };
  }
}
__name(safeVariantOptions, "safeVariantOptions");
function serializePreviewProduct(row, variants = []) {
  return {
    id: String(row.cj_product_id),
    title: String(row.title || "").slice(0, 250),
    image: safeImage(row.image_url),
    variantCount: Math.max(0, Number(row.variant_count) || 0),
    variants: variants.slice(0, 4).map((v) => {
      const options = safeVariantOptions(v.options_json);
      return {
        label: options.label || "Variant",
        sku: String(v.cj_sku || "").slice(0, 100)
      };
    }),
    hasMoreVariants: (Number(row.variant_count) || 0) > variants.slice(0, 4).length
  };
}
__name(serializePreviewProduct, "serializePreviewProduct");
async function getCatalogPreview(db, page) {
  const totalRow = await db.prepare("SELECT COUNT(*) AS total FROM cj_products").first();
  const total = Math.max(0, Number(totalRow?.total) || 0);
  const products = await db.prepare(`SELECT p.cj_product_id, p.id, p.title, p.image_url,
    (SELECT COUNT(*) FROM cj_variants v WHERE v.product_id = p.id) AS variant_count
    FROM cj_products p ORDER BY p.synced_at DESC, p.id ASC
    LIMIT ? OFFSET ?`).bind(PAGE_SIZE2, (page - 1) * PAGE_SIZE2).all();
  const rows = products.results || [];
  let variants = [];
  if (rows.length) {
    const placeholders = rows.map(() => "?").join(",");
    const sql = `SELECT product_id, cj_sku, options_json FROM (
      SELECT product_id, cj_sku, options_json,
        ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY id) AS rn
      FROM cj_variants WHERE product_id IN (${placeholders})
    ) WHERE rn <= 4 ORDER BY product_id, rn`;
    const found = await db.prepare(sql).bind(...rows.map((r) => r.id)).all();
    variants = found.results || [];
  }
  const variantMap = /* @__PURE__ */ new Map();
  for (const row of variants) {
    if (!variantMap.has(row.product_id)) variantMap.set(row.product_id, []);
    variantMap.get(row.product_id).push(row);
  }
  const state = await db.prepare("SELECT last_status FROM cj_sync_state WHERE id = 1").first();
  return {
    kind: "supplier_catalog_preview",
    checkoutEnabled: false,
    publiclyAccessible: true,
    supplierSyncStatus: String(state?.last_status || "not_initialized"),
    page,
    pageSize: PAGE_SIZE2,
    total,
    pages: Math.ceil(total / PAGE_SIZE2),
    products: rows.map((r) => serializePreviewProduct(r, variantMap.get(r.id) || []))
  };
}
__name(getCatalogPreview, "getCatalogPreview");

// src/cart-preview.js
var ID = /^[A-Za-z0-9_-]{1,128}$/;
var MAX_LINES = 15;
var MAX_QUANTITY = 5;
function clean(value, max = 250) {
  return typeof value === "string" ? value.slice(0, max) : "";
}
__name(clean, "clean");
function validCatalogId(value) {
  return typeof value === "string" && ID.test(value);
}
__name(validCatalogId, "validCatalogId");
function validateCartPayload(value) {
  if (!value || !Array.isArray(value.items) || value.items.length > MAX_LINES) return null;
  const seen = /* @__PURE__ */ new Set();
  const items = [];
  for (const item of value.items) {
    if (!item || !validCatalogId(item.variantId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY || seen.has(item.variantId)) return null;
    seen.add(item.variantId);
    items.push({ variantId: item.variantId, quantity: item.quantity });
  }
  return items;
}
__name(validateCartPayload, "validateCartPayload");
async function getCartProductVariants(db, productId) {
  if (!validCatalogId(productId)) return null;
  const product = await db.prepare("SELECT cj_product_id, title FROM cj_products WHERE cj_product_id=?").bind(productId).first();
  if (!product) return null;
  const result = await db.prepare(`SELECT cj_variant_id, cj_sku, options_json
    FROM cj_variants WHERE product_id=? ORDER BY id LIMIT 100`).bind("cj:" + productId).all();
  const variants = (result.results || []).map((row) => {
    const options = safeVariantOptions(row.options_json);
    return {
      id: clean(row.cj_variant_id, 128),
      label: options.label || "Default variant",
      sku: clean(row.cj_sku, 100)
    };
  }).filter((v) => validCatalogId(v.id));
  return { productId, title: clean(product.title), variants, checkoutEnabled: false };
}
__name(getCartProductVariants, "getCartProductVariants");
async function previewCart(db, items) {
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
      variantId: clean(row.cj_variant_id, 128),
      productId: clean(row.cj_product_id, 128),
      title: clean(row.title),
      image: safeImage(row.image_url),
      variantLabel: variant.label || "Default variant",
      sku: clean(row.cj_sku, 100),
      quantity: item.quantity
    });
  }
  return {
    kind: "cj_planning_cart",
    checkoutEnabled: false,
    shippingVerified: false,
    retailPricingVerified: false,
    lines,
    unavailable,
    notice: "This is a planning cart only. Prices, stock, US shipping and checkout are not yet verified."
  };
}
__name(previewCart, "previewCart");
var HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer"
};
var json = /* @__PURE__ */ __name((value, status = 200) => Response.json(value, { status, headers: HEADERS }), "json");
async function handleCartPreview(request, env, route) {
  const url = new URL(request.url);
  if (route === "variants") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const id = url.searchParams.get("productId");
    if (!validCatalogId(id)) return json({ error: "Invalid product ID" }, 400);
    try {
      if (!env.DB) throw new Error("DB missing");
      const result = await getCartProductVariants(env.DB, id);
      return result ? json(result) : json({ error: "Product not found" }, 404);
    } catch {
      return json({ error: "Supplier catalog temporarily unavailable" }, 503);
    }
  }
  if (route === "cart") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (request.headers.get("Origin") !== url.origin) return json({ error: "Origin rejected" }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || ""))
      return json({ error: "JSON required" }, 415);
    if (Number(request.headers.get("Content-Length")) > 5e3) return json({ error: "Cart too large" }, 413);
    let payload;
    try {
      const raw = await request.text();
      if (raw.length > 5e3) return json({ error: "Cart too large" }, 413);
      payload = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const items = validateCartPayload(payload);
    if (!items) return json({ error: "Invalid cart items" }, 400);
    try {
      if (!env.DB) throw new Error("DB missing");
      return json(await previewCart(env.DB, items));
    } catch {
      return json({ error: "Cart preview temporarily unavailable" }, 503);
    }
  }
  return json({ error: "Not found" }, 404);
}
__name(handleCartPreview, "handleCartPreview");

// src/cart-readiness.js
var VALID_ID = /^[A-Za-z0-9_-]{1,128}$/;
var MAX_LINES2 = 15;
var MAX_QTY = 5;
var MAX_BODY = 4e3;
var INVENTORY_FRESH_MS = 24 * 60 * 60 * 1e3;
var JSON_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer"
});
var respond = /* @__PURE__ */ __name((json2, status = 200) => Response.json(json2, { status, headers: JSON_HEADERS }), "respond");
function validateItems(value) {
  if (!value || !Array.isArray(value.items) || value.items.length > MAX_LINES2) return null;
  const seen = /* @__PURE__ */ new Set();
  const clean2 = [];
  for (const item of value.items) {
    if (!item || typeof item.variantId !== "string" || !VALID_ID.test(item.variantId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QTY || seen.has(item.variantId)) return null;
    seen.add(item.variantId);
    clean2.push({ variantId: item.variantId, quantity: item.quantity });
  }
  return clean2;
}
__name(validateItems, "validateItems");
function verifiedDate(value) {
  if (typeof value !== "string" || !value) return null;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
__name(verifiedDate, "verifiedDate");
function assessVariant(row, requestedQty, nowMs) {
  if (!row) return { reason: "not_found", retailPriceCents: null };
  if (row.product_active !== 1 || row.variant_active !== 1)
    return { reason: "not_approved", retailPriceCents: null };
  if (!Number.isSafeInteger(row.retail_price_cents) || row.retail_price_cents < 1 || !verifiedDate(row.retail_verified_at))
    return { reason: "retail_price_unverified", retailPriceCents: null };
  if (!Number.isSafeInteger(row.inventory_quantity) || row.inventory_quantity < 0)
    return { reason: "inventory_unverified", retailPriceCents: null };
  if (row.inventory_quantity < requestedQty)
    return { reason: "insufficient_inventory", retailPriceCents: null };
  const checkedMs = verifiedDate(row.inventory_verified_at);
  if (checkedMs === null || checkedMs > nowMs || nowMs - checkedMs > INVENTORY_FRESH_MS)
    return { reason: "inventory_not_recently_verified", retailPriceCents: null };
  return { reason: "shipping_not_quoted", retailPriceCents: row.retail_price_cents };
}
__name(assessVariant, "assessVariant");
async function checkCartReadiness(db, items, nowMs = Date.now()) {
  const result = [];
  let subtotalCents = 0;
  let approvedItems = 0;
  for (const item of items) {
    const row = await db.prepare(`SELECT v.retail_price_cents, v.inventory_quantity,
      v.active AS variant_active, v.retail_verified_at, v.inventory_verified_at,
      p.active AS product_active
      FROM cj_variants v JOIN cj_products p ON p.id = v.product_id
      WHERE v.cj_variant_id = ? LIMIT 1`).bind(item.variantId).first();
    const checked = assessVariant(row, item.quantity, nowMs);
    if (checked.retailPriceCents !== null) {
      subtotalCents += checked.retailPriceCents * item.quantity;
      approvedItems++;
    }
    result.push({
      variantId: item.variantId,
      quantity: item.quantity,
      reason: checked.reason,
      unitPriceUsd: checked.retailPriceCents === null ? null : (checked.retailPriceCents / 100).toFixed(2)
    });
  }
  const allReadyForShipping = items.length > 0 && approvedItems === items.length;
  return {
    kind: "cj_checkout_readiness",
    currency: "USD",
    customerCheckoutEnabled: false,
    paypalCaptureEnabled: false,
    cjOrderSubmissionEnabled: false,
    productsApprovedForShippingQuote: allReadyForShipping,
    lines: result,
    subtotalUsd: allReadyForShipping ? (subtotalCents / 100).toFixed(2) : null,
    shippingUsd: null,
    grandTotalUsd: null,
    nextAction: allReadyForShipping ? "verify_destination_shipping_and_payment_flow" : "await_product_and_inventory_verification"
  };
}
__name(checkCartReadiness, "checkCartReadiness");
async function handleCheckoutReadiness(request, env) {
  const url = new URL(request.url);
  if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);
  if (request.headers.get("Origin") !== url.origin) return respond({ error: "Origin rejected" }, 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || ""))
    return respond({ error: "JSON required" }, 415);
  if (Number(request.headers.get("Content-Length")) > MAX_BODY) return respond({ error: "Cart too large" }, 413);
  let raw;
  try {
    raw = await request.text();
  } catch {
    return respond({ error: "Invalid request" }, 400);
  }
  if (raw.length > MAX_BODY) return respond({ error: "Cart too large" }, 413);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return respond({ error: "Invalid JSON" }, 400);
  }
  const items = validateItems(payload);
  if (items === null) return respond({ error: "Invalid cart" }, 400);
  try {
    if (!env.DB || typeof env.DB.prepare !== "function") throw new Error("Missing database");
    return respond(await checkCartReadiness(env.DB, items));
  } catch {
    return respond({ error: "Pricing readiness temporarily unavailable" }, 503);
  }
}
__name(handleCheckoutReadiness, "handleCheckoutReadiness");

// src/paypal-sandbox.js
var BASE2 = "https://api-m.sandbox.paypal.com";
var CENTS = 100;
var MONEY = "1.00";
var ALLOWED_APPROVAL_HOSTS = /* @__PURE__ */ new Set(["www.sandbox.paypal.com", "sandbox.paypal.com"]);
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var PAYPAL_ID = /^[A-Za-z0-9]{8,64}$/;
var RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
};
function reply(value, status = 200) {
  return Response.json(value, { status, headers: RESPONSE_HEADERS });
}
__name(reply, "reply");
function sandboxReady(env) {
  return env?.PAYPAL_MODE === "sandbox" && env?.PAYPAL_SANDBOX_CHECKOUT_ENABLED === "true" && Boolean(env?.PAYPAL_SANDBOX_CLIENT_ID) && Boolean(env?.PAYPAL_SANDBOX_CLIENT_SECRET) && Boolean(env?.DB);
}
__name(sandboxReady, "sandboxReady");
function validateApprovalUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || !ALLOWED_APPROVAL_HOSTS.has(url.hostname) || url.port) return null;
    return url.href;
  } catch {
    return null;
  }
}
__name(validateApprovalUrl, "validateApprovalUrl");
function isCompletedCapture(data, checkoutId) {
  if (data?.status !== "COMPLETED" || !Array.isArray(data.purchase_units) || data.purchase_units.length !== 1) return null;
  const unit = data.purchase_units[0];
  if (unit?.custom_id !== checkoutId || !Array.isArray(unit?.payments?.captures) || unit.payments.captures.length !== 1) return null;
  const capture = unit.payments.captures[0];
  if (capture?.status !== "COMPLETED" || !PAYPAL_ID.test(String(capture.id || "")) || capture?.amount?.currency_code !== "USD" || capture.amount.value !== MONEY) return null;
  return capture.id;
}
__name(isCompletedCapture, "isCompletedCapture");
var SandboxError = class extends Error {
  static {
    __name(this, "SandboxError");
  }
  constructor(code) {
    super(code);
    this.code = code;
  }
};
async function getAccessToken(env) {
  let res;
  try {
    res = await fetch(BASE2 + "/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${env.PAYPAL_SANDBOX_CLIENT_ID}:${env.PAYPAL_SANDBOX_CLIENT_SECRET}`),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(12e3)
    });
  } catch {
    throw new SandboxError("PAYPAL_AUTH_NETWORK");
  }
  if (!res.ok) throw new SandboxError("PAYPAL_AUTH_FAILED");
  let data;
  try {
    data = await res.json();
  } catch {
    throw new SandboxError("PAYPAL_AUTH_INVALID");
  }
  if (typeof data?.access_token !== "string" || data.access_token.length < 8)
    throw new SandboxError("PAYPAL_AUTH_INVALID");
  return data.access_token;
}
__name(getAccessToken, "getAccessToken");
async function paypalRequest(env, path, payload, idempotencyKey) {
  const token = await getAccessToken(env);
  let res;
  try {
    res = await fetch(BASE2 + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        Accept: "application/json",
        Prefer: "return=representation",
        "PayPal-Request-Id": idempotencyKey
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15e3)
    });
  } catch {
    throw new SandboxError("PAYPAL_NETWORK");
  }
  if (!res.ok) throw new SandboxError("PAYPAL_API_FAILED");
  try {
    return await res.json();
  } catch {
    throw new SandboxError("PAYPAL_RESPONSE_INVALID");
  }
}
__name(paypalRequest, "paypalRequest");
async function setStatus(db, id, status) {
  await db.prepare("UPDATE sandbox_checkouts SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(status, id).run();
}
__name(setStatus, "setStatus");
async function createCheckout(request, env) {
  const id = crypto.randomUUID();
  const source = new URL(request.url);
  await env.DB.prepare(`INSERT INTO sandbox_checkouts
    (id, status, amount_cents, currency) VALUES (?, 'creating', ?, 'USD')`).bind(id, CENTS).run();
  try {
    const checkoutUrl = new URL("/shop/checkout-test/", source.origin);
    checkoutUrl.searchParams.set("checkoutId", id);
    const returnUrl = new URL(checkoutUrl);
    returnUrl.searchParams.set("result", "approved");
    const cancelUrl = new URL(checkoutUrl);
    cancelUrl.searchParams.set("result", "canceled");
    const order = await paypalRequest(env, "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: id,
        custom_id: id,
        description: "The Soft Nest Edit \u2014 Sandbox test only (no merchandise)",
        amount: { currency_code: "USD", value: MONEY }
      }],
      payment_source: { paypal: { experience_context: {
        brand_name: "The Soft Nest Edit \u2014 Sandbox Test",
        return_url: returnUrl.href,
        cancel_url: cancelUrl.href,
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW"
      } } }
    }, id + "-create");
    const orderId = String(order?.id || "");
    const links = Array.isArray(order?.links) ? order.links : [];
    const approvalUrl = validateApprovalUrl(
      links.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href
    );
    if (!PAYPAL_ID.test(orderId) || !approvalUrl) throw new SandboxError("PAYPAL_CREATE_INVALID");
    await env.DB.prepare(`UPDATE sandbox_checkouts
      SET paypal_order_id=?, status='created', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(orderId, id).run();
    return reply({ checkoutId: id, approvalUrl, environment: "sandbox" }, 201);
  } catch (error) {
    await setStatus(env.DB, id, "needs_review");
    return reply({
      error: "Unable to start a sandbox checkout. Check your PayPal sandbox setup.",
      code: error instanceof SandboxError ? error.code : "SANDBOX_CREATE_FAILED"
    }, 502);
  }
}
__name(createCheckout, "createCheckout");
async function readSmallJson(request) {
  const raw = await request.text();
  if (raw.length > 1024) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
__name(readSmallJson, "readSmallJson");
async function captureCheckout(request, env) {
  const data = await readSmallJson(request);
  const checkoutId = data?.checkoutId;
  if (typeof checkoutId !== "string" || !UUID.test(checkoutId))
    return reply({ error: "Invalid checkout ID" }, 400);
  const existing = await env.DB.prepare(`SELECT id, status, paypal_order_id
    FROM sandbox_checkouts WHERE id=?`).bind(checkoutId).first();
  if (!existing) return reply({ error: "Unknown checkout" }, 404);
  if (existing.status === "paid") return reply({ checkoutId, status: "paid", environment: "sandbox" });
  if (existing.status !== "created" || !PAYPAL_ID.test(String(existing.paypal_order_id || "")))
    return reply({ checkoutId, status: existing.status, error: "This checkout cannot be captured automatically." }, 409);
  const claim = await env.DB.prepare(`UPDATE sandbox_checkouts
    SET status='capturing', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='created'`).bind(checkoutId).run();
  if (claim.meta?.changes !== 1) return reply({ error: "Capture is already processing" }, 409);
  try {
    const result = await paypalRequest(
      env,
      `/v2/checkout/orders/${existing.paypal_order_id}/capture`,
      {},
      checkoutId + "-capture"
    );
    if (result?.id !== existing.paypal_order_id) throw new SandboxError("PAYPAL_ORDER_MISMATCH");
    const captureId = isCompletedCapture(result, checkoutId);
    if (!captureId) throw new SandboxError("PAYPAL_CAPTURE_NOT_VERIFIED");
    await env.DB.prepare(`UPDATE sandbox_checkouts SET
      status='paid', paypal_capture_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='capturing'`).bind(captureId, checkoutId).run();
    return reply({ checkoutId, status: "paid", environment: "sandbox", message: "Sandbox payment verified" });
  } catch (error) {
    await setStatus(env.DB, checkoutId, "needs_review");
    return reply({
      checkoutId,
      status: "needs_review",
      error: "PayPal capture could not be verified. Do not repeat payment; inspect sandbox activity.",
      code: error instanceof SandboxError ? error.code : "SANDBOX_CAPTURE_FAILED"
    }, 502);
  }
}
__name(captureCheckout, "captureCheckout");
async function handleSandboxPaypal(request, env, route) {
  const path = new URL(request.url);
  if (!["config", "create", "capture", "status"].includes(route)) return reply({ error: "Not found" }, 404);
  const expectedMethod = ["config", "status"].includes(route) ? "GET" : "POST";
  if (request.method !== expectedMethod) return reply({ error: "Method not allowed" }, 405);
  if (!sandboxReady(env)) return reply({ error: "Sandbox checkout is disabled or not configured" }, 503);
  if (expectedMethod === "POST") {
    if (request.headers.get("Origin") !== path.origin)
      return reply({ error: "Origin rejected" }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || ""))
      return reply({ error: "JSON required" }, 415);
  }
  try {
    if (route === "config") return reply({
      environment: "sandbox",
      testAmountUsd: MONEY,
      demoCheckoutEnabled: true,
      liveCheckoutEnabled: false,
      cjFulfillmentEnabled: false
    });
    if (route === "create") return await createCheckout(request, env);
    if (route === "capture") return await captureCheckout(request, env);
    const checkoutId = path.searchParams.get("checkoutId");
    if (!UUID.test(checkoutId || "")) return reply({ error: "Invalid checkout ID" }, 400);
    const row = await env.DB.prepare("SELECT status FROM sandbox_checkouts WHERE id=?").bind(checkoutId).first();
    return row ? reply({ checkoutId, status: row.status, environment: "sandbox" }) : reply({ error: "Unknown checkout" }, 404);
  } catch {
    return reply({ error: "Sandbox backend unavailable" }, 503);
  }
}
__name(handleSandboxPaypal, "handleSandboxPaypal");

// src/index.js
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/paypal/sandbox/")) {
      const route = url.pathname.slice("/api/paypal/sandbox/".length);
      return handleSandboxPaypal(request, env, route);
    }
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      try {
        if (!env.DB) throw new Error("Missing D1 binding");
        const row = await env.DB.prepare("SELECT 1 AS connected").first();
        return Response.json(
          { ok: row?.connected === 1, database: "connected" },
          { headers: { "Cache-Control": "no-store" } }
        );
      } catch {
        return Response.json(
          { ok: false, database: "unavailable" },
          { status: 503, headers: { "Cache-Control": "no-store" } }
        );
      }
    }
    if (url.pathname === "/api/catalog/status") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      try {
        if (!env.DB) throw new Error("Missing D1 binding");
        return Response.json(await catalogStatus(env.DB), {
          headers: { "Cache-Control": "no-store" }
        });
      } catch {
        return Response.json({ error: "Catalog sync database not initialized" }, {
          status: 503,
          headers: { "Cache-Control": "no-store" }
        });
      }
    }
    if (url.pathname === "/api/checkout/readiness") {
      return handleCheckoutReadiness(request, env);
    }
    if (url.pathname === "/api/catalog/variants") {
      return handleCartPreview(request, env, "variants");
    }
    if (url.pathname === "/api/catalog/cart") {
      return handleCartPreview(request, env, "cart");
    }
    if (url.pathname === "/api/catalog/preview") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { "Allow": "GET", "Cache-Control": "no-store" }
        });
      }
      const page = parsePreviewPage(url.searchParams.get("page"));
      if (page === null) {
        return Response.json({ error: "Invalid page number" }, {
          status: 400,
          headers: { "Cache-Control": "no-store" }
        });
      }
      try {
        if (!env.DB) throw new Error("D1 missing");
        return Response.json(await getCatalogPreview(env.DB, page), {
          headers: {
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow",
            "Referrer-Policy": "no-referrer"
          }
        });
      } catch {
        return Response.json({ error: "Catalog preview unavailable" }, {
          status: 503,
          headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }
        });
      }
    }
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
  // Runs every six hours, as configured in wrangler.jsonc. No orders are placed.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(syncCjCatalog(env));
  }
};

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-6PvcTo/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-6PvcTo/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
