-- Additive foundations only. No product approvals, live payments or supplier jobs.
ALTER TABLE cj_variants ADD COLUMN supplier_cost_verified_at TEXT;
ALTER TABLE cj_variants ADD COLUMN approved_supplier_cost_cents INTEGER CHECK (approved_supplier_cost_cents > 0);
ALTER TABLE cj_variants ADD COLUMN retail_policy_version TEXT;

-- A supplier cost change must invalidate a merchant's previous pricing approval.
CREATE TRIGGER cj_cost_change_invalidates_retail AFTER UPDATE OF supplier_cost_cents ON cj_variants
WHEN OLD.supplier_cost_cents IS NOT NEW.supplier_cost_cents
BEGIN
  UPDATE cj_variants SET retail_verified_at=NULL, approved_supplier_cost_cents=NULL,
    retail_policy_version=NULL, supplier_cost_verified_at=NULL WHERE id=NEW.id;
END;

-- Shared across scheduled imports and interactive quotes, including Worker isolates.
CREATE TABLE cj_service_gate (
  id INTEGER PRIMARY KEY CHECK (id=1),
  next_request_ms INTEGER NOT NULL DEFAULT 0,
  blocked_until_ms INTEGER NOT NULL DEFAULT 0,
  auth_lock_until_ms INTEGER NOT NULL DEFAULT 0
);
INSERT INTO cj_service_gate(id) VALUES (1);

CREATE TABLE commerce_quotes (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  destination_zip TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents>0),
  shipping_cents INTEGER NOT NULL CHECK(shipping_cents>=0),
  total_cents INTEGER NOT NULL CHECK(total_cents=subtotal_cents+shipping_cents),
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL CHECK(expires_ms>created_ms)
);
CREATE INDEX commerce_quotes_owner ON commerce_quotes(owner_hash, created_ms);

-- Does not relax the existing sandbox_checkouts.amount_cents=100 constraint.
CREATE TABLE product_sandbox_orders (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  request_key TEXT NOT NULL,
  quote_id TEXT NOT NULL UNIQUE REFERENCES commerce_quotes(id),
  status TEXT NOT NULL CHECK(status IN ('creating','create_retry','created','capturing','capture_retry','paid','needs_review')),
  currency TEXT NOT NULL CHECK(currency='USD'),
  subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents>0),
  shipping_cents INTEGER NOT NULL CHECK(shipping_cents>=0),
  total_cents INTEGER NOT NULL CHECK(total_cents=subtotal_cents+shipping_cents),
  snapshot_json TEXT NOT NULL,
  paypal_order_id TEXT UNIQUE,
  approval_url TEXT,
  paypal_capture_id TEXT UNIQUE,
  capture_json TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  operation_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  UNIQUE(owner_hash,request_key)
);
CREATE TABLE product_sandbox_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES product_sandbox_orders(id),
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

-- Future live fulfillment uses the existing paid customer orders, never Sandbox.
ALTER TABLE order_items ADD COLUMN cj_variant_id_snapshot TEXT;
CREATE TABLE fulfillment_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('disabled','pending','submitting','submitted','needs_reconciliation','failed','shipped','delivered')),
  cj_order_id TEXT UNIQUE,
  shipping_address_json TEXT NOT NULL,
  items_json TEXT NOT NULL,
  shipping_method_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0),
  next_retry_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE fulfillment_history (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES fulfillment_jobs(id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
  result TEXT NOT NULL CHECK(result IN ('failed','succeeded','needs_reconciliation','disabled')),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id,attempt_number)
);
CREATE TABLE fulfillment_tracking (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES fulfillment_jobs(id),
  tracking_number TEXT NOT NULL,
  carrier TEXT,
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(job_id,tracking_number,status,observed_at)
);
