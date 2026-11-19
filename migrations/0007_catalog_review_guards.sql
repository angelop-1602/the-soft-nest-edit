-- Keep product-level optimistic versions current when an import adds variants.
CREATE TRIGGER variant_insert_review_version AFTER INSERT ON cj_variants
BEGIN
  UPDATE cj_products SET review_version=review_version+1 WHERE id=NEW.product_id;
END;
CREATE INDEX cj_products_review_state ON cj_products(review_state);
CREATE INDEX cj_variants_review_state ON cj_variants(product_id,review_state);
CREATE INDEX admin_shipping_destination ON admin_shipping_checks(variant_id,origin,destination_zip,quantity,checked_ms DESC);
CREATE TRIGGER product_fixture_mark_safely BEFORE UPDATE OF fixture_only ON cj_products
WHEN NEW.fixture_only=1 AND (NEW.active=1 OR NEW.review_state='approved')
BEGIN SELECT RAISE(ABORT,'Disable a product before isolating it as a fixture'); END;
CREATE TRIGGER variant_fixture_mark_safely BEFORE UPDATE OF fixture_only ON cj_variants
WHEN NEW.fixture_only=1 AND (NEW.active=1 OR NEW.review_state='approved')
BEGIN SELECT RAISE(ABORT,'Disable a variant before isolating it as a fixture'); END;
