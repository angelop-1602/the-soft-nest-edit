-- The Soft Nest Edit: initial order-system schema.
-- Sandbox foundation. This migration does not enable payments or supplier purchases.
-- Amounts are integers in USD cents, not floating-point dollars.

CREATE TABLE IF NOT EXISTS cj_products (
  id TEXT PRIMARY KEY,
  cj_product_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  image_url TEXT,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cj_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES cj_products(id),
  cj_variant_id TEXT NOT NULL UNIQUE,
  cj_sku TEXT,
  options_json TEXT,
  supplier_cost_cents INTEGER CHECK (supplier_cost_cents >= 0),
  retail_price_cents INTEGER CHECK (retail_price_cents >= 0),
  inventory_quantity INTEGER CHECK (inventory_quantity >= 0),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cj_variants_product ON cj_variants(product_id);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  public_reference TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
    'pending_payment','paid','fulfillment_pending','submitted_to_cj',
    'supplier_paid','shipped','delivered','canceled','refunded','manual_review'
  )),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  shipping_cents INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  paypal_order_id TEXT UNIQUE,
  paypal_capture_id TEXT UNIQUE,
  cj_order_id TEXT UNIQUE,
  cj_tracking_number TEXT,
  -- Only collect customer delivery details in the secure server-side checkout flow.
  -- Keep access private and implement a retention/purge policy before live sales.
  shipping_address_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status,created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  variant_id TEXT NOT NULL REFERENCES cj_variants(id),
  title_snapshot TEXT NOT NULL,
  sku_snapshot TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- Verified PayPal webhook event IDs are inserted once for deduplication.
CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id),
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Durable audit trail for reconciliation, retries, and failed supplier operations.
-- Never automatically retry an ambiguous CJ create/pay result without first reconciling.
CREATE TABLE IF NOT EXISTS fulfillment_attempts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  action TEXT NOT NULL CHECK (action IN ('create_cj_order','pay_cj_order','fetch_tracking')),
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','needs_reconciliation')),
  cj_reference TEXT,
  error_code TEXT,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fulfillment_attempts_order ON fulfillment_attempts(order_id, attempted_at);
