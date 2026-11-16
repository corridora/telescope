import { getBindingString } from '@/lib/auth';

import type { ForwardingConfiguration } from './types';

function numberSetting(
  bindings: object,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = getBindingString(bindings, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

/** A missing destination or an explicitly disabled switch stops automatic sends. */
export function forwardingEnabled(bindings: object): boolean {
  return (
    !!getBindingString(bindings, 'UPLOAD_FORWARD_URL') &&
    getBindingString(bindings, 'UPLOAD_FORWARD_ENABLED') !== 'false'
  );
}

/** Validate the administrator-selected destination without resolving caller input. */
export function validateForwardingDestination(
  bindings: object,
  destinationUrl: string,
  ownOrigin?: string,
): URL {
  const url = new URL(destinationUrl);
  if (url.username || url.password || url.hash) {
    throw new Error(
      'The forwarding URL must not contain credentials or a fragment',
    );
  }
  const allowHttp =
    getBindingString(bindings, 'UPLOAD_FORWARD_ALLOW_HTTP') === 'true';
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error(
      'Forwarding requires HTTPS; local HTTP requires an explicit exception',
    );
  }
  const aliases = (
    getBindingString(bindings, 'TELESCOPE_INSTANCE_ORIGINS') ?? ''
  )
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (ownOrigin) aliases.push(ownOrigin);
  if (aliases.includes(url.origin) && /^\/api\/upload\/?$/.test(url.pathname)) {
    throw new Error('The forwarding destination points to this instance');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateName =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.internal') ||
    !hostname.includes('.') ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname === '::1' ||
    /^(?:f[cd][a-f0-9]{2}|fe80):/i.test(hostname);
  if (
    privateName &&
    getBindingString(bindings, 'UPLOAD_FORWARD_ALLOW_PRIVATE') !== 'true'
  ) {
    throw new Error(
      'Private forwarding destinations require UPLOAD_FORWARD_ALLOW_PRIVATE=true',
    );
  }
  return url;
}

/** Snapshot non-secret delivery settings; a changed destination gets a new identity. */
export async function getForwardingConfiguration(
  bindings: object,
  ownOrigin?: string,
): Promise<ForwardingConfiguration | null> {
  if (!forwardingEnabled(bindings)) return null;
  const destinationUrl = validateForwardingDestination(
    bindings,
    getBindingString(bindings, 'UPLOAD_FORWARD_URL')!,
    ownOrigin,
  ).href;
  const instanceId = getBindingString(bindings, 'TELESCOPE_INSTANCE_ID');
  if (!instanceId || !/^[a-zA-Z0-9_-]{8,128}$/.test(instanceId)) {
    throw new Error(
      'Configure TELESCOPE_INSTANCE_ID with 8–128 letters, digits, underscores or hyphens',
    );
  }
  const mode = getBindingString(bindings, 'UPLOAD_FORWARD_MODE') ?? 'http';
  if (mode !== 'http' && mode !== 'telescope') {
    throw new Error('UPLOAD_FORWARD_MODE must be http or telescope');
  }
  const versionInput = JSON.stringify({
    destinationUrl,
    mode,
    review: getBindingString(bindings, 'ENABLE_AI_RATING') === 'true',
    revision:
      getBindingString(bindings, 'UPLOAD_FORWARD_CONFIG_VERSION') ?? '1',
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(versionInput),
  );
  const version = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return {
    destinationUrl,
    destinationLabel: (
      getBindingString(bindings, 'UPLOAD_FORWARD_LABEL') ??
      'Configured destination'
    ).slice(0, 160),
    mode,
    instanceId,
    version,
    timeoutMs: numberSetting(
      bindings,
      'UPLOAD_FORWARD_TIMEOUT_MS',
      15_000,
      1_000,
      120_000,
    ),
    maxAttempts: numberSetting(
      bindings,
      'UPLOAD_FORWARD_MAX_ATTEMPTS',
      6,
      1,
      30,
    ),
    maxAgeMs: numberSetting(
      bindings,
      'UPLOAD_FORWARD_MAX_AGE_MS',
      86_400_000,
      60_000,
      30 * 86_400_000,
    ),
    maxArchiveBytes: numberSetting(
      bindings,
      'UPLOAD_FORWARD_MAX_ARCHIVE_BYTES',
      32 * 1024 * 1024,
      1,
      256 * 1024 * 1024,
    ),
    maxSpoolBytes: numberSetting(
      bindings,
      'UPLOAD_FORWARD_MAX_SPOOL_BYTES',
      1024 * 1024 * 1024,
      1,
      1024 * 1024 * 1024 * 1024,
    ),
    terminalRetentionMs: numberSetting(
      bindings,
      'UPLOAD_FORWARD_FAILED_RETENTION_MS',
      86_400_000,
      0,
      30 * 86_400_000,
    ),
    acceptedRetentionMs: numberSetting(
      bindings,
      'UPLOAD_FORWARD_ACCEPTED_RETENTION_MS',
      0,
      0,
      30 * 86_400_000,
    ),
    requireReview: getBindingString(bindings, 'ENABLE_AI_RATING') === 'true',
  };
}
