-- Existing uploads retain public visibility and remain readable after migration.
ALTER TABLE tests ADD COLUMN publication_state TEXT NOT NULL DEFAULT 'committed';
ALTER TABLE tests ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE tests ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE tests ADD COLUMN run_type TEXT NOT NULL DEFAULT 'single';
ALTER TABLE tests ADD COLUMN step_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tests ADD COLUMN core_test_id TEXT;
ALTER TABLE tests ADD COLUMN artifact_prefix TEXT;
ALTER TABLE tests ADD COLUMN artifact_manifest TEXT;
ALTER TABLE tests ADD COLUMN original_zip_key TEXT;
ALTER TABLE tests ADD COLUMN ingestion_token TEXT;
ALTER TABLE tests ADD COLUMN ingestion_expires_at INTEGER;
ALTER TABLE tests ADD COLUMN ingestion_error TEXT;
CREATE INDEX idx_tests_publication_visibility
  ON tests(publication_state, visibility, created_at DESC);
