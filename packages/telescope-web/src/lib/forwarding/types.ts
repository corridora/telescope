/** A forwarding request is independent from local capture and ingestion state. */
export type ForwardingState =
  | 'waiting_review'
  | 'pending'
  | 'sending'
  | 'retrying'
  | 'paused'
  | 'accepted'
  | 'blocked'
  | 'expired'
  | 'failed'
  | 'cancelled';

export interface ForwardingConfiguration {
  destinationUrl: string;
  destinationLabel: string;
  mode: 'http' | 'telescope';
  instanceId: string;
  version: string;
  timeoutMs: number;
  maxAttempts: number;
  maxAgeMs: number;
  maxArchiveBytes: number;
  maxSpoolBytes: number;
  terminalRetentionMs: number;
  acceptedRetentionMs: number;
  requireReview: boolean;
}

/** The subset of the ingestion receipt required by the forwarding outbox. */
export interface ForwardUploadReceipt {
  testId: string;
  zipKey: string;
  contentRating: string;
  duplicate: boolean;
  originalZipKey?: string;
  originalZipSize?: number;
}

export interface ForwardMetadata {
  source: string;
  name?: string;
  description?: string;
  filename?: string;
}

export interface ForwardProvenance {
  /** Only a verified peer may suppress automatic forwarding. */
  trusted: boolean;
  chain: string[];
}

/** Durable D1 row. Secrets are resolved at send time, never stored here. */
export interface ForwardingDeliveryRow {
  delivery_id: string;
  test_id: string;
  archive_key: string;
  archive_sha256: string;
  archive_size: number;
  filename: string;
  metadata_json: string;
  destination_url: string;
  destination_label: string;
  config_version: string;
  settings_json: string;
  instance_chain: string;
  state: ForwardingState;
  attempt_count: number;
  retry_budget_start: number;
  created_at: number;
  updated_at: number;
  next_attempt_at: number;
  source_expires_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  last_status: number | null;
  last_error: string | null;
  receipt_json: string | null;
  terminal_at: number | null;
  archive_deleted_at: number | null;
  cancel_requested: number;
}

export interface ForwardingDelivery {
  deliveryId: string;
  testId: string;
  destinationLabel: string;
  state: ForwardingState;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string | null;
  sourceExpiresAt: string;
  lastStatus: number | null;
  error: string | null;
  receipt: ForwardingReceipt | null;
  retryAvailable: boolean;
  cancellationRequested: boolean;
}

export interface ForwardingReceipt {
  status: number;
  accepted: true;
  durableStorageConfirmed: boolean;
  remoteTestId?: string;
  remoteResultUrl?: string;
}

export interface ForwardingProcessResult {
  claimed: number;
  accepted: number;
  retried: number;
  failed: number;
}

export interface ForwardingAttempt {
  attemptId: string;
  sequence: number;
  startedAt: string;
  endedAt: string | null;
  outcome: string;
  status: number | null;
  error: string | null;
}
