-- PayPal SANDBOX-only checkout testing. No real orders, customer PII,
-- supplier payments or CJ fulfillment. USD one-dollar fixed server-side test.
-- Keep separate from the real `orders` table.
CREATE TABLE IF NOT EXISTS sandbox_checkouts (
  id TEXT PRIMARY KEY,
  paypal_order_id TEXT UNIQUE,
  paypal_capture_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'creating', 'created', 'capturing', 'paid', 'needs_review'
  )),
  amount_cents INTEGER NOT NULL CHECK (amount_cents = 100),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sandbox_checkouts_status ON sandbox_checkouts(status, created_at);
