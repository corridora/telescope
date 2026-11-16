/** Durable agent/controller protocol records, separate from captured metrics. */
export interface AgentRecord {
  id: string;
  name: string;
  token_hash: string;
  status: 'active' | 'draining' | 'revoked';
  capabilities_json: string;
  session_id: string | null;
  last_seen: number | null;
  created_at: number;
}

export interface JobRecord {
  id: string;
  agent_id: string;
  name: string | null;
  description: string | null;
  options_json: string;
  secrets_json: string | null;
  request_hash: string;
  idempotency_key: string;
  execution_state: string;
  delivery_state: string;
  active_attempt_id: string | null;
  cancel_requested: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
  error: string | null;
  delivery_error: string | null;
}

export interface AttemptRecord {
  id: string;
  job_id: string;
  agent_id: string;
  session_id: string;
  lease_hash: string;
  lease_until: number;
  execution_state: string;
  delivery_state: string;
  event_sequence: number;
  progress_json: string | null;
  core_test_id: string | null;
  result_id: string;
  receipt_json: string | null;
  error: string | null;
  delivery_error: string | null;
  created_at: number;
  updated_at: number;
}
