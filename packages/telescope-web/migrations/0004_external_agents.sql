CREATE TABLE IF NOT EXISTS telescope_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  session_id TEXT,
  last_seen INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telescope_jobs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES telescope_agents(id),
  name TEXT,
  description TEXT,
  options_json TEXT NOT NULL,
  secrets_json TEXT,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  execution_state TEXT NOT NULL DEFAULT 'queued',
  delivery_state TEXT NOT NULL DEFAULT 'not_started',
  active_attempt_id TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  error TEXT,
  delivery_error TEXT
);

CREATE INDEX IF NOT EXISTS telescope_jobs_claim ON telescope_jobs(agent_id, execution_state, created_at);

CREATE TABLE IF NOT EXISTS telescope_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES telescope_jobs(id),
  agent_id TEXT NOT NULL REFERENCES telescope_agents(id),
  session_id TEXT NOT NULL,
  lease_hash TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  execution_state TEXT NOT NULL DEFAULT 'claimed',
  delivery_state TEXT NOT NULL DEFAULT 'not_started',
  event_sequence INTEGER NOT NULL DEFAULT 0,
  progress_json TEXT,
  core_test_id TEXT,
  result_id TEXT NOT NULL UNIQUE,
  receipt_json TEXT,
  error TEXT,
  delivery_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS telescope_attempts_lease ON telescope_attempts(lease_until, delivery_state);
CREATE INDEX IF NOT EXISTS telescope_attempts_job ON telescope_attempts(job_id, created_at);
