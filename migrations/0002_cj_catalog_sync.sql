-- CJ product sync state. Separate from retail sale data.
-- Access tokens are stored server-side and must never be served by API endpoints.
CREATE TABLE IF NOT EXISTS cj_api_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  access_expires_ms INTEGER NOT NULL,
  refresh_token TEXT,
  refresh_expires_ms INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cj_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_page INTEGER NOT NULL DEFAULT 1 CHECK (next_page >= 1),
  total_records INTEGER NOT NULL DEFAULT 0 CHECK (total_records >= 0),
  last_run_at TEXT,
  last_success_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'never',
  last_error_code TEXT,
  last_processed INTEGER NOT NULL DEFAULT 0,
  lock_until INTEGER NOT NULL DEFAULT 0,
  lock_token TEXT
);
INSERT OR IGNORE INTO cj_sync_state (id) VALUES (1);
