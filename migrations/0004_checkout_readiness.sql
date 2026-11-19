-- Shipping/retail approval provenance. CJ's background product importer does not
-- set these verification timestamps, and cannot implicitly enable selling.
-- Kept nullable so all existing imported variants remain in safe preview mode.
ALTER TABLE cj_variants ADD COLUMN retail_verified_at TEXT;
ALTER TABLE cj_variants ADD COLUMN inventory_verified_at TEXT;
ALTER TABLE cj_variants ADD COLUMN origin_country_code TEXT CHECK (origin_country_code IN ('CN','US'));
