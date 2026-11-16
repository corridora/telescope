import { env } from 'cloudflare:workers';
import { z } from 'zod';
import {
  IdentityManifestSchema,
  ResultManifestSchema,
  ScenarioManifestSchema,
  TestIdSchema,
} from '@cloudflare/telescope/contracts';

import type { APIContext } from 'astro';
import type {
  AgentCommitGuard,
  IngestResult,
  ResultIngestionMetadata,
  StoredArtifact,
} from '@/lib/types/tests';
import { ContentRating, TestSource } from '@/lib/types/tests';
import { getPrismaClient } from '@/lib/prisma/client';
import {
  claimIngestion,
  commitIngestion,
  createTest,
  getTestById,
  renewIngestion,
} from '@/lib/repositories/testRepository';
import {
  isStorableArtifactPath,
  MAX_ARCHIVE_FILES,
  MAX_MANIFEST_BYTES,
} from '@/lib/utils/security';
import {
  CaptureConfigSchema,
  IngestionError,
  reviewStoredResult,
  sha256,
  validateInteractionMetrics,
} from './resultStore';
import { tokenMatches } from '@/lib/auth';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const LEASE_SECONDS = 600;
const FileMapSchema = z.record(
  z.string().refine(isStorableArtifactPath, 'Unsupported artifact path'),
  z.object({
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);

export interface AgentTransferOptions {
  resultId: string;
  coreTestId?: string;
  metadata: ResultIngestionMetadata;
  expectedUrl?: string;
  executionState?: string;
  files: Record<string, StoredArtifact>;
}

interface TransferRecord extends AgentTransferOptions {
  checksum: string;
}

interface TransferRow {
  publication_state: string;
  zip_key: string;
  ingestion_token: string | null;
  ingestion_expires_at: number | bigint | null;
}

export interface AgentTransferReceipt extends IngestResult {
  resultId: string;
  stored: true;
  checksum: string;
}

function transferKey(resultId: string): string {
  return `_private/transfers/${resultId}.json`;
}

function hashHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function transferRow(
  context: APIContext,
  resultId: string,
): Promise<TransferRow | null> {
  const rows = await getPrismaClient(context).$queryRaw<TransferRow[]>`
    SELECT publication_state, zip_key, ingestion_token, ingestion_expires_at
    FROM tests WHERE test_id = ${resultId} LIMIT 1`;
  return rows[0] ?? null;
}

async function loadTransfer(resultId: string): Promise<TransferRecord> {
  TestIdSchema.parse(resultId);
  const object = await env.RESULTS_BUCKET.get(transferKey(resultId));
  if (!object || object.size > MAX_MANIFEST_BYTES * 4)
    throw new IngestionError('Transfer manifest unavailable', 404);
  const record = await object.json<TransferRecord>();
  FileMapSchema.parse(record.files);
  if (record.resultId !== resultId || !/^[a-f0-9]{64}$/.test(record.checksum))
    throw new IngestionError('Invalid stored transfer');
  return record;
}

async function assertTransferOwner(
  context: APIContext,
  resultId: string,
  transferId: string,
): Promise<TransferRecord> {
  TestIdSchema.parse(resultId);
  const row = await transferRow(context, resultId);
  if (
    !row ||
    row.publication_state !== 'staging' ||
    !row.ingestion_token ||
    !(await tokenMatches(row.ingestion_token, transferId)) ||
    Number(row.ingestion_expires_at ?? 0) < Math.floor(Date.now() / 1000)
  ) {
    throw new IngestionError('Transfer ownership expired or changed', 409);
  }
  const renewed = await renewIngestion(
    getPrismaClient(context),
    resultId,
    transferId,
    Math.floor(Date.now() / 1000) + LEASE_SECONDS,
  );
  if (!renewed) throw new IngestionError('Transfer ownership changed', 409);
  return loadTransfer(resultId);
}

/**
 * Reserve a private result and immutable file manifest. Callers authenticate and
 * fence the assigned agent/attempt before invoking any transfer helper.
 */
export async function beginAgentTransfer(
  context: APIContext,
  options: AgentTransferOptions,
) {
  TestIdSchema.parse(options.resultId);
  if (options.coreTestId) TestIdSchema.parse(options.coreTestId);
  const files = FileMapSchema.parse(options.files);
  const filenames = Object.keys(files).sort();
  if (
    filenames.length < 2 ||
    filenames.length > MAX_ARCHIVE_FILES ||
    !files['config.json'] ||
    !files['result.json']
  ) {
    throw new IngestionError(
      'A transfer needs config.json, result.json, and a bounded file manifest',
    );
  }
  let total = 0;
  for (const [filename, descriptor] of Object.entries(files)) {
    total += descriptor.size;
    if (
      descriptor.size > MAX_FILE_BYTES ||
      (filename.endsWith('.json') && descriptor.size > 8 * 1024 * 1024) ||
      (filename.endsWith('.har') && descriptor.size > 16 * 1024 * 1024) ||
      ((filename === 'config.json' ||
        filename === 'result.json' ||
        filename === 'scenario.json') &&
        descriptor.size > MAX_MANIFEST_BYTES)
    ) {
      throw new IngestionError(
        `Artifact ${filename} exceeds the transfer size limit`,
        413,
      );
    }
  }
  if (total > MAX_TOTAL_BYTES)
    throw new IngestionError(
      'Capture exceeds the total transfer size limit',
      413,
    );
  const canonical = JSON.stringify(
    filenames.map(filename => [
      filename,
      files[filename].size,
      files[filename].sha256,
    ]),
  );
  const checksum = await sha256(new TextEncoder().encode(canonical));
  const prisma = getPrismaClient(context);
  let row = await transferRow(context, options.resultId);
  if (row && row.zip_key !== checksum)
    throw new IngestionError(
      'The result ID already belongs to a different manifest',
      409,
    );
  if (!row) {
    try {
      await createTest(prisma, {
        testId: options.resultId,
        zipKey: checksum,
        source: TestSource.AGENT,
        name: options.metadata.name,
        description: options.metadata.description,
        url: options.expectedUrl ?? 'https://pending.invalid/',
        testDate: Math.floor(Date.now() / 1000),
        browser: 'pending',
        publicationState: 'staging',
        visibility: 'private',
        executionStatus: options.executionState ?? 'unknown',
        coreTestId: options.coreTestId,
      });
    } catch {
      row = await transferRow(context, options.resultId);
      if (!row || row.zip_key !== checksum)
        throw new IngestionError('Capture identity conflict', 409);
    }
    row = await transferRow(context, options.resultId);
  }
  if (!row) throw new IngestionError('Unable to reserve result', 500);
  const limits = {
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxFiles: MAX_ARCHIVE_FILES,
  };
  if (row.publication_state === 'committed') {
    return {
      transferId: '',
      resultId: options.resultId,
      testId: options.resultId,
      stored: true,
      checksum,
      limits,
    };
  }
  let transferId = row.ingestion_token;
  const now = Math.floor(Date.now() / 1000);
  if (!transferId || Number(row.ingestion_expires_at ?? 0) < now) {
    transferId = crypto.randomUUID();
    if (
      !(await claimIngestion(
        prisma,
        options.resultId,
        transferId,
        now,
        now + LEASE_SECONDS,
      ))
    ) {
      throw new IngestionError(
        'Another transfer claimed this capture; retry begin',
        409,
      );
    }
  } else if (
    !(await renewIngestion(
      prisma,
      options.resultId,
      transferId,
      now + LEASE_SECONDS,
    ))
  ) {
    throw new IngestionError('Transfer ownership changed', 409);
  }
  const record: TransferRecord = { ...options, files, checksum };
  await env.RESULTS_BUCKET.put(
    transferKey(options.resultId),
    JSON.stringify(record),
    {
      httpMetadata: { contentType: 'application/json' },
    },
  );
  return {
    transferId,
    resultId: options.resultId,
    testId: options.resultId,
    stored: false,
    checksum,
    limits,
  };
}

/** Store a declared file directly from its request stream with R2 checksum validation. */
export async function uploadAgentArtifact(
  context: APIContext,
  options: {
    resultId: string;
    transferId: string;
    filename: string;
    request: Request;
  },
) {
  const record = await assertTransferOwner(
    context,
    options.resultId,
    options.transferId,
  );
  const descriptor = record.files[options.filename];
  if (!isStorableArtifactPath(options.filename) || !descriptor)
    throw new IngestionError('Undeclared artifact');
  const key = `${options.resultId}/${options.filename}`;
  const previous = await env.RESULTS_BUCKET.head(key);
  if (previous) {
    if (
      previous.size !== descriptor.size ||
      !previous.checksums.sha256 ||
      hashHex(previous.checksums.sha256) !== descriptor.sha256
    ) {
      throw new IngestionError(
        'Stored artifact conflicts with this transfer',
        409,
      );
    }
    await options.request.body?.cancel();
    return { stored: true, filename: options.filename };
  }
  const length = options.request.headers.get('Content-Length');
  if (
    length === null ||
    Number(length) !== descriptor.size ||
    (!options.request.body && descriptor.size !== 0)
  ) {
    throw new IngestionError(
      'Artifact Content-Length must match its declared size',
      411,
    );
  }
  try {
    const stored = await env.RESULTS_BUCKET.put(
      key,
      descriptor.size === 0 ? new Uint8Array(0) : options.request.body!,
      {
        sha256: Uint8Array.from(descriptor.sha256.match(/../g)!, byte =>
          parseInt(byte, 16),
        ).buffer,
        onlyIf: { etagDoesNotMatch: '*' },
        customMetadata: { sha256: descriptor.sha256 },
      },
    );
    if (!stored || stored.size !== descriptor.size)
      throw new Error('Artifact write was not accepted');
  } catch {
    throw new IngestionError(
      'Artifact transfer failed integrity/length validation; retry the same file',
      409,
    );
  }
  return { stored: true, filename: options.filename };
}

async function storedJson<T>(
  resultId: string,
  filename: string,
  parse: (value: unknown) => T,
  maximumBytes = MAX_MANIFEST_BYTES,
): Promise<T> {
  const object = await env.RESULTS_BUCKET.get(`${resultId}/${filename}`);
  if (!object || object.size > maximumBytes)
    throw new IngestionError(`Missing or oversized ${filename}`);
  try {
    return parse(await object.json());
  } catch {
    throw new IngestionError(`Invalid ${filename}`);
  }
}

/** Verify stored files and publish the private capture before returning its receipt. */
export async function commitAgentTransfer(
  context: APIContext,
  options: {
    resultId: string;
    transferId: string;
    beforeCommit?: (receipt: IngestResult) => Promise<void>;
    commitGuard?: AgentCommitGuard;
  },
): Promise<AgentTransferReceipt> {
  const existing = await getTestById(
    getPrismaClient(context),
    options.resultId,
  );
  if (existing) {
    return {
      resultId: options.resultId,
      testId: options.resultId,
      stored: true,
      checksum: (await transferRow(context, options.resultId))!.zip_key,
      zipKey: (await transferRow(context, options.resultId))!.zip_key,
      contentRating: existing.content_rating as ContentRating,
      duplicate: true,
      publicationState: 'committed',
      files: existing.artifact_manifest
        ? JSON.parse(existing.artifact_manifest)
        : {},
    };
  }
  const record = await assertTransferOwner(
    context,
    options.resultId,
    options.transferId,
  );
  if (!options.commitGuard)
    throw new IngestionError(
      'An assigned agent attempt is required for publication',
      409,
    );
  // Paginated metadata listing keeps commit bounded even for many filmstrip
  // frames. This metadata was attached only after R2 validated each upload hash.
  const found = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.RESULTS_BUCKET.list({
      prefix: `${record.resultId}/`,
      cursor,
      include: ['customMetadata'],
    });
    for (const stored of page.objects) {
      const filename = stored.key.slice(record.resultId.length + 1);
      const descriptor = record.files[filename];
      if (!descriptor)
        throw new IngestionError(
          'Stored artifact was not declared by this transfer',
          409,
        );
      if (
        stored.size !== descriptor.size ||
        stored.customMetadata?.sha256 !== descriptor.sha256
      ) {
        throw new IngestionError(
          `Missing or corrupt artifact: ${filename}`,
          409,
        );
      }
      found.add(filename);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (const filename of Object.keys(record.files)) {
    if (!found.has(filename))
      throw new IngestionError(`Missing artifact: ${filename}`, 409);
  }
  const config = await storedJson(record.resultId, 'config.json', value =>
    CaptureConfigSchema.parse(value),
  );
  const manifest = await storedJson(record.resultId, 'result.json', value =>
    ResultManifestSchema.parse(value),
  );
  const identity = record.files['identity.json']
    ? await storedJson(record.resultId, 'identity.json', value =>
        IdentityManifestSchema.parse(value),
      )
    : undefined;
  if (
    config.url !== config.options.url ||
    (record.expectedUrl && config.url !== record.expectedUrl) ||
    (record.coreTestId && manifest.testId !== record.coreTestId) ||
    (typeof config.testId === 'string' && config.testId !== manifest.testId) ||
    (identity && identity.testId !== manifest.testId) ||
    manifest.status === 'running'
  ) {
    throw new IngestionError(
      'Capture configuration or identity does not match the assigned job',
    );
  }
  const verify = (filename: string, descriptor: StoredArtifact) => {
    const actual = record.files[filename];
    if (
      !actual ||
      actual.size !== descriptor.size ||
      actual.sha256 !== descriptor.sha256
    ) {
      throw new IngestionError(
        `Declared capture artifact is missing or changed: ${filename}`,
      );
    }
  };
  for (const [filename, descriptor] of Object.entries(manifest.artifacts))
    verify(filename, descriptor);
  const scenario = record.files['scenario.json']
    ? await storedJson(record.resultId, 'scenario.json', value =>
        ScenarioManifestSchema.parse(value),
      )
    : undefined;
  if (scenario?.status === 'running')
    throw new IngestionError('Scenario is still running');
  if (
    scenario?.coverStepId &&
    !scenario.steps.some(step => step.id === scenario.coverStepId)
  ) {
    throw new IngestionError('Unknown scenario cover step');
  }
  if (scenario?.video && !record.files[scenario.video.path])
    throw new IngestionError('Missing scenario recording');
  for (const step of scenario?.steps ?? []) {
    for (const [filename, descriptor] of Object.entries(step.artifacts ?? {}))
      verify(`${step.artifactBase}/${filename}`, descriptor);
    if (step.status === 'passed') {
      for (const filename of [
        'metrics.json',
        'resources.json',
        'console.json',
        'pageload.har',
      ]) {
        if (!record.files[`${step.artifactBase}/${filename}`])
          throw new IngestionError(`Passed step is missing ${filename}`);
      }
    }
    const metricsPath = `${step.artifactBase}/metrics.json`;
    if (step.kind === 'interaction' && record.files[metricsPath]) {
      const metrics = await storedJson(
        record.resultId,
        metricsPath,
        value => value,
        8 * 1024 * 1024,
      );
      validateInteractionMetrics(metrics);
    }
  }
  const stepIds = new Set(scenario?.steps.map(step => step.id) ?? []);
  for (const filename of Object.keys(record.files)) {
    const match = /^steps\/(\d{4})\//.exec(filename);
    if (match && !stepIds.has(match[1]))
      throw new IngestionError('Undeclared scenario step');
  }
  const rating =
    env.ENABLE_AI_RATING === 'true'
      ? ContentRating.UNKNOWN
      : ContentRating.SAFE;
  const receipt: AgentTransferReceipt = {
    resultId: record.resultId,
    testId: record.resultId,
    stored: true,
    checksum: record.checksum,
    zipKey: record.checksum,
    contentRating: rating,
    duplicate: false,
    publicationState: 'committed',
    files: record.files,
  };
  await options.beforeCommit?.(receipt);
  const prisma = getPrismaClient(context);
  await prisma.$executeRaw`
    UPDATE tests SET url = ${config.url}, test_date = ${Math.floor(new Date(config.date).getTime() / 1000)},
      browser = ${config.options.browser ?? config.browserConfig.engine},
      core_test_id = ${manifest.testId}, execution_status = ${scenario?.status ?? manifest.status},
      run_type = ${scenario ? 'scenario' : 'single'}, step_count = ${scenario?.steps.length ?? 1}
    WHERE test_id = ${record.resultId} AND ingestion_token = ${options.transferId}
      AND publication_state = 'staging'`;
  await commitIngestion(
    prisma,
    record.resultId,
    options.transferId,
    record.files,
    undefined,
    rating,
    options.commitGuard,
  );
  if (env.ENABLE_AI_RATING === 'true' && env.AI) {
    context.locals.cfContext.waitUntil(
      reviewStoredResult(context, record.resultId),
    );
  }
  return receipt;
}
