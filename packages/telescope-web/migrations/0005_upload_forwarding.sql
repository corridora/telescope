CREATE TABLE IF NOT EXISTS upload_forward_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  test_id TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  archive_size INTEGER NOT NULL,
  filename TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  destination_label TEXT NOT NULL,
  config_version TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  instance_chain TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retry_budget_start INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  source_expires_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_status INTEGER,
  last_error TEXT,
  receipt_json TEXT,
  terminal_at INTEGER,
  archive_deleted_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  UNIQUE (test_id, config_version)
);
CREATE INDEX IF NOT EXISTS upload_forward_due
  ON upload_forward_deliveries (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS upload_forward_test
  ON upload_forward_deliveries (test_id);

CREATE TABLE IF NOT EXISTS upload_forward_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  delivery_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT NOT NULL,
  status INTEGER,
  error TEXT,
  UNIQUE (delivery_id, sequence)
);
CREATE INDEX IF NOT EXISTS upload_forward_attempt_delivery
  ON upload_forward_attempts (delivery_id, sequence);
