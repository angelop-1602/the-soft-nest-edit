/**
 * Unpriced, read-only D1 CJ catalog preview. Never exposes supplier costs, customer
 * orders, private CJ access tokens, retail pricing, inventory, or checkout links.
 * This staging API is PUBLIC. It is not an admin/authenticated endpoint.
 */
import { safeImage } from './cj-sync.js';

const PAGE_SIZE = 16;
const MAX_PAGE = 100;

export function parsePreviewPage(raw) {
  if (raw === null) return 1;
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_PAGE ? n : null;
}

export function safeVariantOptions(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      label: typeof value?.label === 'string' ? value.label.slice(0, 160) : '',
      image: safeImage(value?.image) || null
    };
  } catch {
    return { label: '', image: null };
  }
}

export function serializePreviewProduct(row, variants = []) {
  return {
    id: String(row.cj_product_id),
    title: String(row.title || '').slice(0, 250),
    image: safeImage(row.image_url),
    variantCount: Math.max(0, Number(row.variant_count) || 0),
    variants: variants.slice(0, 4).map(v => {
      const options = safeVariantOptions(v.options_json);
      return {
        label: options.label || 'Variant',
        sku: String(v.cj_sku || '').slice(0, 100)
      };
    }),
    hasMoreVariants: (Number(row.variant_count) || 0) > variants.slice(0, 4).length
  };
}

export async function getCatalogPreview(db, page) {
  // The table stores the original supplier metadata, but this route never
  // returns price/cost, inventory, warehouse, personal data, or order state.
  const totalRow = await db.prepare('SELECT COUNT(*) AS total FROM cj_products').first();
  const total = Math.max(0, Number(totalRow?.total) || 0);
  const products = await db.prepare(`SELECT p.cj_product_id, p.id, p.title, p.image_url,
    (SELECT COUNT(*) FROM cj_variants v WHERE v.product_id = p.id) AS variant_count
    FROM cj_products p ORDER BY p.synced_at DESC, p.id ASC
    LIMIT ? OFFSET ?`)
    .bind(PAGE_SIZE, (page - 1) * PAGE_SIZE).all();

  const rows = products.results || [];
  let variants = [];
  if (rows.length) {
    const placeholders = rows.map(() => '?').join(',');
    const sql = `SELECT product_id, cj_sku, options_json FROM (
      SELECT product_id, cj_sku, options_json,
        ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY id) AS rn
      FROM cj_variants WHERE product_id IN (${placeholders})
    ) WHERE rn <= 4 ORDER BY product_id, rn`;
    const found = await db.prepare(sql).bind(...rows.map(r => r.id)).all();
    variants = found.results || [];
  }
  const variantMap = new Map();
  for (const row of variants) {
    if (!variantMap.has(row.product_id)) variantMap.set(row.product_id, []);
    variantMap.get(row.product_id).push(row);
  }
  const state = await db.prepare('SELECT last_status FROM cj_sync_state WHERE id = 1').first();
  return {
    kind: 'supplier_catalog_preview',
    checkoutEnabled: false,
    publiclyAccessible: true,
    supplierSyncStatus: String(state?.last_status || 'not_initialized'),
    page,
    pageSize: PAGE_SIZE,
    total,
    pages: Math.ceil(total / PAGE_SIZE),
    products: rows.map(r => serializePreviewProduct(r, variantMap.get(r.id) || []))
  };
}
