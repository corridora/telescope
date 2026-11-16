import { env } from 'cloudflare:workers';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import {
  IdentityManifestSchema,
  ResultManifestSchema,
  ScenarioManifestSchema,
} from '@cloudflare/telescope/contracts';

import type { APIContext } from 'astro';
import type { Unzipped } from 'fflate';
import type {
  AgentCommitGuard,
  IngestResult,
  ResultIngestionMetadata,
  ResultVisibility,
  StoredArtifact,
} from '@/lib/types/tests';
import { ContentRating } from '@/lib/types/tests';
import { getPrismaClient } from '@/lib/prisma/client';
import {
  claimIngestion,
  commitIngestion,
  createTest,
  failIngestion,
  findTestIdByZipKey,
  getTestById,
  renewIngestion,
} from '@/lib/repositories/testRepository';
import { rateUrlContent } from '@/lib/ai/ai-content-rater';
import { generateTestId } from '@/lib/utils/testId';
import {
  inspectZipArchive,
  isExpectedTelescopeFile,
  isStorableArtifactPath,
  isValidTestId,
  MAX_ARCHIVE_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_MANIFEST_BYTES,
  normalizeAndFilterZipFiles,
  toPosixPath,
} from '@/lib/utils/security';

export type { IngestResult } from '@/lib/types/tests';

export interface IngestOptions {
  metadata: ResultIngestionMetadata;
  visibility?: ResultVisibility;
  resultId?: string;
  coreTestId?: string;
  retainOriginal?: boolean;
  beforeCommit?: (receipt: IngestResult) => Promise<void>;
  commitGuard?: AgentCommitGuard;
}

/** An expected ingestion failure with a safe HTTP status/message. */
export class IngestionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'IngestionError';
  }
}

export const CaptureConfigSchema = z
  .object({
    url: z.string().refine(value => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, 'URL must be a valid HTTP or HTTPS URL'),
    date: z
      .string()
      .refine(
        value => Number.isFinite(new Date(value).getTime()),
        'Invalid capture date',
      ),
    options: z
      .object({ url: z.string(), browser: z.string().optional() })
      .passthrough(),
    browserConfig: z.object({ engine: z.string() }).passthrough(),
  })
  .passthrough();

/** Compute archive/artifact identity independently from multipart boundaries. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new Uint8Array(bytes).buffer,
  );
  return Array.from(new Uint8Array(hash), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Prevent interaction intervals from reusing an earlier document's navigation. */
export function validateInteractionMetrics(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new IngestionError('Interaction metrics must be a JSON object');
  if (Reflect.get(value, 'navigationTiming') != null)
    throw new IngestionError(
      'Interaction metrics must not contain inherited navigation timing',
    );
}

/** Read a bounded body even when Content-Length is absent or misleading. */
export async function readRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > maxBytes)
    throw new IngestionError('Upload exceeds the request-size limit', 413);
  if (!request.body) throw new IngestionError('Missing upload body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new IngestionError('Upload exceeds the request-size limit', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** A result artifact reader shared by hosted pages and delivery services. */
export function createResultStore(bucket: R2Bucket = env.RESULTS_BUCKET) {
  return {
    get(testId: string, filename: string) {
      if (!isValidTestId(testId) || !isExpectedTelescopeFile(filename))
        throw new IngestionError('Invalid artifact path');
      return bucket.get(`${testId}/${filename}`);
    },
    head(testId: string, filename: string) {
      if (!isValidTestId(testId) || !isExpectedTelescopeFile(filename))
        throw new IngestionError('Invalid artifact path');
      return bucket.head(`${testId}/${filename}`);
    },
    async list(testId: string): Promise<string[]> {
      if (!isValidTestId(testId)) throw new IngestionError('Invalid result ID');
      const prefix = `${testId}/`;
      const files: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        files.push(
          ...page.objects
            .map(object => object.key.slice(prefix.length))
            .filter(isStorableArtifactPath),
        );
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return files;
    },
  };
}

function parseJson<T>(
  files: Unzipped,
  filename: string,
  parse: (value: unknown) => T,
): T {
  const bytes = files[filename];
  if (!bytes || bytes.byteLength > MAX_MANIFEST_BYTES)
    throw new IngestionError(`Missing or oversized ${filename}`);
  try {
    return parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    throw new IngestionError(
      `Invalid ${filename}: ${(error as Error).message.slice(0, 300)}`,
    );
  }
}

/** Validate and extract one flat or single-wrapper Telescope archive. */
export async function parseResultArchive(archive: Uint8Array) {
  try {
    inspectZipArchive(archive);
  } catch (error) {
    throw new IngestionError(
      (error as Error).message,
      archive.byteLength > MAX_ARCHIVE_BYTES ? 413 : 400,
    );
  }
  let unzipped: Unzipped;
  try {
    unzipped = unzipSync(archive, {
      filter: file => !file.name.endsWith('/'),
    });
  } catch {
    throw new IngestionError('ZIP contents could not be decompressed');
  }
  const entries = Object.keys(unzipped);
  const rootConfig = entries.find(
    filename => toPosixPath(filename) === 'config.json',
  );
  const wrapped = entries.filter(filename =>
    /^[^/]+\/config\.json$/.test(toPosixPath(filename)),
  );
  const configPath =
    rootConfig ?? (wrapped.length === 1 ? wrapped[0] : undefined);
  if (!configPath)
    throw new IngestionError(
      'Archive must contain one root config.json or one wrapper directory',
    );
  const prefix = configPath.slice(0, -'config.json'.length);
  let expanded = 0;
  for (const bytes of Object.values(unzipped)) expanded += bytes.byteLength;
  if (expanded > MAX_EXPANDED_BYTES)
    throw new IngestionError('Archive expanded-size limit exceeded', 413);
  const files = normalizeAndFilterZipFiles(unzipped, prefix);
  const config = parseJson(files, 'config.json', value =>
    CaptureConfigSchema.parse(value),
  );
  if (config.options.url !== config.url)
    throw new IngestionError('Capture URL does not match saved options');
  const manifest = files['result.json']
    ? parseJson(files, 'result.json', value =>
        ResultManifestSchema.parse(value),
      )
    : undefined;
  const identity = files['identity.json']
    ? parseJson(files, 'identity.json', value =>
        IdentityManifestSchema.parse(value),
      )
    : undefined;
  const scenario = files['scenario.json']
    ? parseJson(files, 'scenario.json', value =>
        ScenarioManifestSchema.parse(value),
      )
    : undefined;
  if (manifest?.status === 'running' || scenario?.status === 'running') {
    throw new IngestionError(
      'A running capture cannot be published as a finished result',
    );
  }
  if (manifest && identity && manifest.testId !== identity.testId)
    throw new IngestionError('Conflicting capture identities');
  // Portable manifests also describe generated reports. Retain declared inert
  // files for export; direct artifact routes still reject executable HTML.
  const retainDeclared = (filename: string) => {
    if (!isStorableArtifactPath(filename))
      throw new IngestionError(`Unsupported declared artifact: ${filename}`);
    if (!files[filename]) {
      const original = entries.find(
        entry =>
          entry.startsWith(prefix) &&
          toPosixPath(entry.slice(prefix.length)) === filename,
      );
      if (!original)
        throw new IngestionError(`Missing declared artifact: ${filename}`);
      files[filename] = unzipped[original];
    }
  };
  for (const filename of Object.keys(manifest?.artifacts ?? {}))
    retainDeclared(filename);
  for (const step of scenario?.steps ?? []) {
    for (const filename of Object.keys(step.artifacts ?? {}))
      retainDeclared(`${step.artifactBase}/${filename}`);
  }
  const descriptors: Record<string, StoredArtifact> = {};
  for (const [filename, bytes] of Object.entries(files)) {
    descriptors[filename] = { size: bytes.length, sha256: await sha256(bytes) };
  }
  const verify = (filename: string, descriptor: StoredArtifact) => {
    const actual = descriptors[filename];
    if (
      !isStorableArtifactPath(filename) ||
      !actual ||
      actual.size !== descriptor.size ||
      actual.sha256 !== descriptor.sha256
    ) {
      throw new IngestionError(
        `Missing or corrupt declared artifact: ${filename}`,
      );
    }
  };
  for (const [filename, descriptor] of Object.entries(
    manifest?.artifacts ?? {},
  ))
    verify(filename, descriptor);
  if (scenario) {
    const stepIds = new Set(scenario.steps.map(step => step.id));
    if (scenario.coverStepId && !stepIds.has(scenario.coverStepId))
      throw new IngestionError('Unknown scenario cover step');
    if (scenario.video && !descriptors[scenario.video.path])
      throw new IngestionError('Missing scenario recording');
    for (const step of scenario.steps) {
      for (const [filename, descriptor] of Object.entries(
        step.artifacts ?? {},
      )) {
        verify(`${step.artifactBase}/${filename}`, descriptor);
      }
      if (step.status === 'passed') {
        for (const filename of [
          'metrics.json',
          'resources.json',
          'console.json',
          'pageload.har',
        ]) {
          if (!files[`${step.artifactBase}/${filename}`])
            throw new IngestionError(
              `Passed step ${step.id} is missing ${filename}`,
            );
        }
      }
      const metrics = files[`${step.artifactBase}/metrics.json`];
      if (step.kind === 'interaction' && metrics) {
        if (metrics.byteLength > 8 * 1024 * 1024)
          throw new IngestionError(
            'Interaction metrics exceed the JSON size limit',
            413,
          );
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(metrics),
          );
        } catch {
          throw new IngestionError(
            `Invalid metrics for interaction step ${step.id}`,
          );
        }
        validateInteractionMetrics(value);
      }
    }
    for (const filename of Object.keys(files)) {
      const stepMatch = /^steps\/(\d{4})\//.exec(filename);
      if (stepMatch && !stepIds.has(stepMatch[1]))
        throw new IngestionError(
          'Artifact references an undeclared scenario step',
        );
    }
  } else if (
    Object.keys(files).some(filename => filename.startsWith('steps/'))
  ) {
    throw new IngestionError('Step artifacts require a scenario manifest');
  }
  return {
    files,
    descriptors,
    config,
    manifest,
    scenario,
    coreTestId: manifest?.testId ?? identity?.testId,
  };
}

/**
 * Save required artifact bytes before publication, retaining incomplete state for
 * retry recovery. Duplicate completion returns its existing committed receipt.
 */
export async function ingestResultArchive(
  context: APIContext,
  archive: Uint8Array,
  options: IngestOptions,
): Promise<IngestResult> {
  const parsed = await parseResultArchive(archive);
  const prisma = getPrismaClient(context);
  const zipKey = await sha256(archive);
  let existing = await findTestIdByZipKey(prisma, zipKey);
  if (options.resultId && !isValidTestId(options.resultId))
    throw new IngestionError('Invalid reserved result ID');
  if (
    options.coreTestId &&
    parsed.coreTestId &&
    options.coreTestId !== parsed.coreTestId
  )
    throw new IngestionError(
      'Capture identity does not match the assigned attempt',
    );
  if (existing && options.resultId && existing.testId !== options.resultId)
    throw new IngestionError(
      'Archive is already assigned to another result',
      409,
    );
  if (
    existing?.visibility === 'private' &&
    !context.locals.isAdmin &&
    options.resultId !== existing.testId
  ) {
    throw new IngestionError('Archive already exists', 409);
  }
  if (existing?.publicationState === 'committed') {
    const row = await getTestById(prisma, existing.testId);
    return {
      testId: existing.testId,
      zipKey,
      contentRating: existing.contentRating as ContentRating,
      duplicate: true,
      publicationState: 'committed',
      originalZipKey: row?.original_zip_key ?? undefined,
      files: row?.artifact_manifest
        ? JSON.parse(row.artifact_manifest)
        : parsed.descriptors,
    };
  }
  const testId =
    existing?.testId ?? options.resultId ?? generateTestId(parsed.config.date);
  if (!existing) {
    try {
      await createTest(prisma, {
        testId,
        zipKey,
        ...options.metadata,
        url: parsed.config.url,
        testDate: Math.floor(new Date(parsed.config.date).getTime() / 1000),
        browser:
          parsed.config.options.browser ?? parsed.config.browserConfig.engine,
        publicationState: 'staging',
        visibility: options.visibility ?? 'public',
        executionStatus:
          parsed.scenario?.status ?? parsed.manifest?.status ?? 'unknown',
        runType: parsed.scenario ? 'scenario' : 'single',
        stepCount: parsed.scenario?.steps.length ?? 1,
        coreTestId: parsed.coreTestId ?? options.coreTestId,
      });
    } catch (error) {
      existing = await findTestIdByZipKey(prisma, zipKey);
      if (existing)
        throw new IngestionError(
          'This archive is being saved by another request; retry shortly',
          409,
        );
      throw error;
    }
  }
  const token = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  if (!(await claimIngestion(prisma, testId, token, now, now + 600))) {
    throw new IngestionError(
      'This archive is being saved by another request; retry shortly',
      409,
    );
  }
  const ratingEnabled = env.ENABLE_AI_RATING === 'true';
  const receipt: IngestResult = {
    testId,
    zipKey,
    contentRating: ratingEnabled ? ContentRating.UNKNOWN : ContentRating.SAFE,
    duplicate: false,
    publicationState: 'committed',
    originalZipKey: options.retainOriginal
      ? `_private/uploads/${testId}/${zipKey}.zip`
      : undefined,
    originalZipSize: options.retainOriginal ? archive.byteLength : undefined,
    files: parsed.descriptors,
  };
  try {
    const renew = async () => {
      if (
        !(await renewIngestion(
          prisma,
          testId,
          token,
          Math.floor(Date.now() / 1000) + 600,
        ))
      ) {
        throw new IngestionError('Ingestion ownership changed', 409);
      }
    };
    for (const [filename, bytes] of Object.entries(parsed.files)) {
      await renew();
      await env.RESULTS_BUCKET.put(`${testId}/${filename}`, bytes, {
        customMetadata: { sha256: parsed.descriptors[filename].sha256 },
      });
    }
    if (receipt.originalZipKey) {
      await renew();
      await env.RESULTS_BUCKET.put(receipt.originalZipKey, archive, {
        httpMetadata: { contentType: 'application/zip' },
        customMetadata: { sha256: zipKey },
      });
    }
    await renew();
    await options.beforeCommit?.(receipt);
    await commitIngestion(
      prisma,
      testId,
      token,
      receipt.files,
      receipt.originalZipKey,
      receipt.contentRating,
      options.commitGuard,
    );
  } catch (error) {
    await failIngestion(prisma, testId, token, (error as Error).message).catch(
      () => undefined,
    );
    throw error;
  }
  if (ratingEnabled && env.AI) {
    context.locals.cfContext.waitUntil(reviewStoredResult(context, testId));
  }
  return receipt;
}

/** Re-run persisted content review after a restart or an interrupted review request. */
export async function reviewStoredResult(
  _context: APIContext,
  testId: string,
): Promise<void> {
  await reviewCapturedResult(testId);
}

async function reviewCapturedResult(
  testId: string,
  bindings: typeof env = env,
): Promise<void> {
  if (bindings.ENABLE_AI_RATING !== 'true' || !bindings.AI) return;
  const row = await bindings.TELESCOPE_DB.prepare(
    "SELECT test_id FROM tests WHERE test_id = ? AND publication_state = 'committed'",
  )
    .bind(testId)
    .first();
  if (!row) return;
  const setRating = async (rating: ContentRating) => {
    await bindings.TELESCOPE_DB.prepare(
      "UPDATE tests SET content_rating = ?, updated_at = unixepoch() WHERE test_id = ? AND publication_state = 'committed'",
    )
      .bind(rating, testId)
      .run();
  };
  await setRating(ContentRating.IN_PROGRESS);
  try {
    const store = createResultStore(bindings.RESULTS_BUCKET);
    const configObject = await store.get(testId, 'config.json');
    if (!configObject) throw new Error('Missing capture config');
    const config = CaptureConfigSchema.parse(await configObject.json());
    const scenarioObject = await store.get(testId, 'scenario.json');
    const scenario = scenarioObject
      ? ScenarioManifestSchema.parse(await scenarioObject.json())
      : undefined;
    const captures = scenario
      ? scenario.steps
          .filter(
            step => step.status !== 'skipped' && step.status !== 'pending',
          )
          .map(step => ({
            base: `${step.artifactBase}/`,
            url: step.endingUrl ?? step.startingUrl ?? config.url,
          }))
      : [{ base: '', url: config.url }];
    let finalRating = ContentRating.SAFE;
    if (captures.length === 0) finalRating = ContentRating.UNKNOWN;
    for (const capture of captures) {
      const metrics = await store.get(testId, `${capture.base}metrics.json`);
      const screenshot = await store.get(
        testId,
        `${capture.base}screenshot.png`,
      );
      if (!metrics && !screenshot) {
        finalRating = ContentRating.UNKNOWN;
        break;
      }
      const rating = await rateUrlContent(
        bindings.AI,
        capture.url,
        metrics ? new Uint8Array(await metrics.arrayBuffer()) : undefined,
        screenshot ? new Uint8Array(await screenshot.arrayBuffer()) : undefined,
      );
      if (rating !== ContentRating.SAFE) {
        finalRating = rating;
        break;
      }
    }
    await setRating(finalRating);
  } catch {
    await setRating(ContentRating.UNKNOWN);
  }
}

/** Reconcile stale ingestion leases and retry a bounded batch of interrupted reviews. */
export async function maintainStoredResults(
  bindings: typeof env = env,
): Promise<void> {
  await bindings.TELESCOPE_DB.prepare(
    `UPDATE tests SET publication_state = 'failed', ingestion_token = NULL,
      ingestion_expires_at = NULL, updated_at = unixepoch(),
      ingestion_error = 'Upload interrupted; retry the original archive or transfer to resume'
     WHERE publication_state = 'staging' AND ingestion_expires_at < unixepoch()`,
  ).run();
  if (bindings.ENABLE_AI_RATING !== 'true' || !bindings.AI) return;
  const pending = await bindings.TELESCOPE_DB.prepare(
    `SELECT test_id FROM tests WHERE publication_state = 'committed'
      AND content_rating IN ('unknown', 'in_progress')
      AND COALESCE(updated_at, 0) < unixepoch() - 60
     ORDER BY updated_at LIMIT 2`,
  ).all<{ test_id: string }>();
  for (const result of pending.results)
    await reviewCapturedResult(result.test_id, bindings);
}
