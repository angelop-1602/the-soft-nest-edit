-- Private administrator review and audit foundation. No payments or supplier jobs.
ALTER TABLE cj_products ADD COLUMN review_state TEXT NOT NULL DEFAULT 'pending_review'
  CHECK(review_state IN ('pending_review','needs_verification','approved','rejected','disabled'));
ALTER TABLE cj_products ADD COLUMN review_version INTEGER NOT NULL DEFAULT 0 CHECK(review_version>=0);
ALTER TABLE cj_products ADD COLUMN fixture_only INTEGER NOT NULL DEFAULT 0 CHECK(fixture_only IN (0,1));
ALTER TABLE cj_products ADD COLUMN description_text TEXT NOT NULL DEFAULT '';
ALTER TABLE cj_products ADD COLUMN review_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE cj_products ADD COLUMN review_reason TEXT;
ALTER TABLE cj_products ADD COLUMN last_admin_mutation TEXT;
ALTER TABLE cj_variants ADD COLUMN review_state TEXT NOT NULL DEFAULT 'pending_review'
  CHECK(review_state IN ('pending_review','needs_verification','approved','rejected','disabled'));
ALTER TABLE cj_variants ADD COLUMN review_version INTEGER NOT NULL DEFAULT 0 CHECK(review_version>=0);
ALTER TABLE cj_variants ADD COLUMN fixture_only INTEGER NOT NULL DEFAULT 0 CHECK(fixture_only IN (0,1));
ALTER TABLE cj_variants ADD COLUMN review_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE cj_variants ADD COLUMN review_reason TEXT;
ALTER TABLE cj_variants ADD COLUMN approved_review_version INTEGER;
ALTER TABLE cj_variants ADD COLUMN pricing_exception_json TEXT;
ALTER TABLE cj_variants ADD COLUMN last_admin_mutation TEXT;

-- Legacy active flags are not evidence of the new quality/shipping review.
UPDATE cj_products SET active=0,review_state='needs_verification' WHERE active=1;
UPDATE cj_variants SET active=0,review_state='needs_verification' WHERE active=1;
-- Bootstrap the known local fixture once. Runtime enforcement uses immutable flags.
UPDATE cj_products SET fixture_only=1,active=0,review_state='disabled'
  WHERE cj_product_id='QA-PENDING-P1' OR lower(title) LIKE 'local qa fixture%';
UPDATE cj_variants SET fixture_only=1,active=0,review_state='disabled'
  WHERE product_id IN (SELECT id FROM cj_products WHERE fixture_only=1);

CREATE TABLE admin_pricing_policy (
  id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
  policy_json TEXT, last_admin_mutation TEXT, updated_ms INTEGER
);
INSERT INTO admin_pricing_policy(id) VALUES(1);
CREATE TABLE admin_mutations (
  id TEXT PRIMARY KEY, product_id TEXT REFERENCES cj_products(id), created_ms INTEGER NOT NULL
);
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY, actor_sub TEXT NOT NULL, actor_email TEXT NOT NULL,
  auth_source TEXT NOT NULL, action TEXT NOT NULL,
  product_id TEXT REFERENCES cj_products(id), variant_id TEXT REFERENCES cj_variants(id),
  before_json TEXT, after_json TEXT, reason TEXT, created_ms INTEGER NOT NULL
);
CREATE INDEX admin_audit_product ON admin_audit(product_id,created_ms DESC);
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
CREATE TABLE admin_supplier_checks (
  id TEXT PRIMARY KEY, variant_id TEXT NOT NULL REFERENCES cj_variants(id),
  status TEXT NOT NULL CHECK(status IN ('verified','not_verified','error')),
  origin TEXT CHECK(origin IN ('US','CN')), error_code TEXT,
  checked_ms INTEGER NOT NULL, actor_sub TEXT NOT NULL
);
CREATE TABLE admin_shipping_checks (
  id TEXT PRIMARY KEY, variant_id TEXT NOT NULL REFERENCES cj_variants(id),
  origin TEXT NOT NULL CHECK(origin IN ('US','CN')), destination_zip TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 5),
  status TEXT NOT NULL CHECK(status IN ('available','unavailable','error')),
  methods_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
  checked_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL CHECK(expires_ms>checked_ms),
  error_code TEXT, actor_sub TEXT NOT NULL
);
CREATE INDEX admin_shipping_variant ON admin_shipping_checks(variant_id,checked_ms DESC);

CREATE TRIGGER product_fixture_immutable BEFORE UPDATE OF fixture_only ON cj_products
WHEN OLD.fixture_only=1 AND NEW.fixture_only<>1 BEGIN SELECT RAISE(ABORT,'Fixture isolation is permanent'); END;
CREATE TRIGGER variant_fixture_immutable BEFORE UPDATE OF fixture_only ON cj_variants
WHEN OLD.fixture_only=1 AND NEW.fixture_only<>1 BEGIN SELECT RAISE(ABORT,'Fixture isolation is permanent'); END;
CREATE TRIGGER product_fixture_no_sale BEFORE UPDATE OF active,review_state ON cj_products
WHEN NEW.fixture_only=1 AND (NEW.active=1 OR NEW.review_state='approved')
BEGIN SELECT RAISE(ABORT,'Fixtures cannot be sold'); END;
CREATE TRIGGER product_fixture_no_sale_insert BEFORE INSERT ON cj_products
WHEN NEW.fixture_only=1 AND (NEW.active=1 OR NEW.review_state='approved')
BEGIN SELECT RAISE(ABORT,'Fixtures cannot be sold'); END;
CREATE TRIGGER variant_fixture_no_sale BEFORE UPDATE OF active,review_state ON cj_variants
WHEN (NEW.fixture_only=1 OR EXISTS(SELECT 1 FROM cj_products WHERE id=NEW.product_id AND fixture_only=1))
  AND (NEW.active=1 OR NEW.review_state='approved') BEGIN SELECT RAISE(ABORT,'Fixtures cannot be sold'); END;
CREATE TRIGGER variant_fixture_no_sale_insert BEFORE INSERT ON cj_variants
WHEN (NEW.fixture_only=1 OR EXISTS(SELECT 1 FROM cj_products WHERE id=NEW.product_id AND fixture_only=1))
  AND (NEW.active=1 OR NEW.review_state='approved') BEGIN SELECT RAISE(ABORT,'Fixtures cannot be sold'); END;

CREATE TRIGGER product_material_review AFTER UPDATE OF title,image_url,description_text,review_json ON cj_products
WHEN OLD.title IS NOT NEW.title OR OLD.image_url IS NOT NEW.image_url
  OR OLD.description_text IS NOT NEW.description_text OR OLD.review_json IS NOT NEW.review_json
BEGIN
  UPDATE cj_products SET active=0,review_state=CASE WHEN fixture_only=1 THEN 'disabled' ELSE 'needs_verification' END,
    review_json=CASE WHEN OLD.title IS NOT NEW.title OR OLD.image_url IS NOT NEW.image_url THEN '{}' ELSE review_json END,
    review_version=review_version+1 WHERE id=NEW.id;
  UPDATE cj_variants SET active=0,review_state=CASE WHEN fixture_only=1 THEN 'disabled' ELSE 'needs_verification' END,
    review_version=review_version+1,approved_review_version=NULL,review_json='{}' WHERE product_id=NEW.id;
  INSERT INTO admin_audit(id,actor_sub,actor_email,auth_source,action,product_id,before_json,after_json,reason,created_ms)
    VALUES(lower(hex(randomblob(16))),'system','system','safety_guard','automatic_invalidation',NEW.id,
      json_object('active',OLD.active),json_object('active',0),'Product content changed',CAST(strftime('%s','now') AS INTEGER)*1000);
END;

CREATE TRIGGER variant_material_review AFTER UPDATE OF supplier_cost_cents,inventory_quantity,origin_country_code,options_json,cj_sku ON cj_variants
WHEN OLD.supplier_cost_cents IS NOT NEW.supplier_cost_cents OR OLD.inventory_quantity IS NOT NEW.inventory_quantity
  OR OLD.origin_country_code IS NOT NEW.origin_country_code OR OLD.options_json IS NOT NEW.options_json OR OLD.cj_sku IS NOT NEW.cj_sku
BEGIN
  UPDATE cj_variants SET review_version=review_version+1,
    active=CASE WHEN OLD.supplier_cost_cents IS NOT NEW.supplier_cost_cents OR OLD.origin_country_code IS NOT NEW.origin_country_code
      OR OLD.options_json IS NOT NEW.options_json OR OLD.cj_sku IS NOT NEW.cj_sku OR NEW.inventory_quantity IS NULL OR NEW.inventory_quantity<1 THEN 0 ELSE active END,
    review_state=CASE WHEN fixture_only=1 THEN 'disabled' WHEN OLD.supplier_cost_cents IS NOT NEW.supplier_cost_cents OR OLD.origin_country_code IS NOT NEW.origin_country_code
      OR OLD.options_json IS NOT NEW.options_json OR OLD.cj_sku IS NOT NEW.cj_sku OR NEW.inventory_quantity IS NULL OR NEW.inventory_quantity<1 THEN 'needs_verification' ELSE review_state END,
    approved_review_version=CASE WHEN OLD.supplier_cost_cents IS NOT NEW.supplier_cost_cents OR OLD.origin_country_code IS NOT NEW.origin_country_code
      OR OLD.options_json IS NOT NEW.options_json OR OLD.cj_sku IS NOT NEW.cj_sku OR NEW.inventory_quantity IS NULL OR NEW.inventory_quantity<1 THEN NULL ELSE review_version+1 END,
    pricing_exception_json=CASE WHEN OLD.supplier_cost_cents IS NOT NEW.supplier_cost_cents THEN NULL ELSE pricing_exception_json END,
    review_json=CASE WHEN OLD.options_json IS NOT NEW.options_json OR OLD.cj_sku IS NOT NEW.cj_sku THEN '{}' ELSE review_json END
    WHERE id=NEW.id;
  UPDATE cj_products SET review_version=review_version+1 WHERE id=NEW.product_id;
  INSERT INTO admin_audit(id,actor_sub,actor_email,auth_source,action,product_id,variant_id,before_json,after_json,reason,created_ms)
    VALUES(lower(hex(randomblob(16))),'system','system','safety_guard','supplier_data_changed',NEW.product_id,NEW.id,
      json_object('costCents',OLD.supplier_cost_cents,'stock',OLD.inventory_quantity,'origin',OLD.origin_country_code),
      json_object('costCents',NEW.supplier_cost_cents,'stock',NEW.inventory_quantity,'origin',NEW.origin_country_code),
      'Supplier fields changed; unsafe approvals invalidated',CAST(strftime('%s','now') AS INTEGER)*1000);
END;
