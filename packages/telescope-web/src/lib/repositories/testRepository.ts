import type { PrismaClient } from '@/generated/prisma/client';
import type {
  AgentCommitGuard,
  StoredArtifact,
  TestConfig,
  Tests,
} from '@/lib/types/tests';
import { ContentRating } from '@/lib/types/tests';

/** Normalize SQLite raw integer values for Astro/JSON consumers. */
function normalizeTest(row: Tests): Tests {
  return {
    ...row,
    test_date: Number(row.test_date),
    step_count: Number(row.step_count ?? 1),
    ingestion_expires_at:
      row.ingestion_expires_at == null
        ? null
        : Number(row.ingestion_expires_at),
  };
}

/** Create metadata, optionally holding a new result out of public reads. */
export async function createTest(
  prisma: PrismaClient,
  config: TestConfig,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO tests (
      test_id, zip_key, name, description, source, url, test_date, browser,
      content_rating, publication_state, visibility, execution_status,
      run_type, step_count, core_test_id, artifact_prefix
    ) VALUES (
      ${config.testId}, ${config.zipKey}, ${config.name ?? null},
      ${config.description ?? null}, ${config.source}, ${config.url},
      ${config.testDate}, ${config.browser}, ${ContentRating.UNKNOWN},
      ${config.publicationState ?? 'committed'}, ${config.visibility ?? 'public'},
      ${config.executionStatus ?? 'unknown'}, ${config.runType ?? 'single'},
      ${config.stepCount ?? 1}, ${config.coreTestId ?? null}, ${`${config.testId}/`}
    )`;
}

/** Find duplicate archives, including incomplete ingestions for recovery. */
export async function findTestIdByZipKey(prisma: PrismaClient, zipKey: string) {
  const rows = await prisma.$queryRaw<Tests[]>`
    SELECT * FROM tests WHERE zip_key = ${zipKey} LIMIT 1`;
  const row = rows[0];
  return row
    ? {
        testId: row.test_id,
        contentRating: row.content_rating,
        publicationState: row.publication_state ?? 'committed',
        visibility: row.visibility ?? 'public',
        ingestionExpiresAt:
          row.ingestion_expires_at == null
            ? null
            : Number(row.ingestion_expires_at),
      }
    : null;
}

/** Get a committed result. Visibility is enforced at the request boundary. */
export async function getTestById(
  prisma: PrismaClient,
  testId: string,
): Promise<Tests | null> {
  const rows = await prisma.$queryRaw<Tests[]>`
    SELECT * FROM tests
    WHERE test_id = ${testId} AND publication_state = 'committed'
    LIMIT 1`;
  return rows[0] ? normalizeTest(rows[0]) : null;
}

/** Read access/publication metadata, including uncommitted captures. */
export async function getTestAccess(prisma: PrismaClient, testId: string) {
  const rows = await prisma.$queryRaw<
    Pick<Tests, 'visibility' | 'publication_state'>[]
  >`
    SELECT visibility, publication_state FROM tests WHERE test_id = ${testId} LIMIT 1`;
  return rows[0] ?? null;
}

/** List committed captures, optionally including this administrator's private results. */
export async function getAllTests(
  prisma: PrismaClient,
  aiEnabled: boolean,
  includePrivate = false,
): Promise<Tests[]> {
  const rows = await prisma.$queryRaw<Tests[]>`
    SELECT * FROM tests
    WHERE publication_state = 'committed'
      AND (${includePrivate ? 1 : 0} = 1 OR visibility = 'public')
      AND (${aiEnabled ? 1 : 0} = 0 OR content_rating = ${ContentRating.SAFE})
    ORDER BY created_at DESC`;
  return rows.map(normalizeTest);
}

/** Read content review only for an artifact-complete capture. */
export async function getTestRating(prisma: PrismaClient, testId: string) {
  const rows = await prisma.$queryRaw<
    { content_rating: string; url: string }[]
  >`
    SELECT content_rating, url FROM tests
    WHERE test_id = ${testId} AND publication_state = 'committed'
    LIMIT 1`;
  return rows[0] ? { rating: rows[0].content_rating, url: rows[0].url } : null;
}

/** Update instance content-review state after publication. */
export async function updateContentRating(
  prisma: PrismaClient,
  testId: string,
  rating: ContentRating,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE tests SET content_rating = ${rating}, updated_at = unixepoch()
    WHERE test_id = ${testId} AND publication_state = 'committed'`;
}

/** Claim a staged/failed ingestion, fencing concurrent uploads and recovery. */
export async function claimIngestion(
  prisma: PrismaClient,
  testId: string,
  token: string,
  now: number,
  expiresAt: number,
): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE tests SET publication_state = 'staging', ingestion_token = ${token},
      ingestion_expires_at = ${expiresAt}, ingestion_error = NULL,
      updated_at = unixepoch()
    WHERE test_id = ${testId} AND publication_state <> 'committed'
      AND (ingestion_token IS NULL OR ingestion_expires_at < ${now})`;
  return changed === 1;
}

/** Renew an ingestion between bounded storage operations. */
export async function renewIngestion(
  prisma: PrismaClient,
  testId: string,
  token: string,
  expiresAt: number,
): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE tests SET ingestion_expires_at = ${expiresAt}, updated_at = unixepoch()
    WHERE test_id = ${testId} AND ingestion_token = ${token}
      AND publication_state = 'staging' AND ingestion_expires_at >= unixepoch()`;
  return changed === 1;
}

/** Publish only after required files and any durable forwarding intent exist. */
export async function commitIngestion(
  prisma: PrismaClient,
  testId: string,
  token: string,
  files: Record<string, StoredArtifact>,
  originalZipKey: string | undefined,
  rating: ContentRating,
  guard?: AgentCommitGuard,
): Promise<void> {
  const changed = guard
    ? await prisma.$executeRaw`
    UPDATE tests SET publication_state = 'committed',
      artifact_manifest = ${JSON.stringify(files)},
      original_zip_key = ${originalZipKey ?? null}, content_rating = ${rating},
      ingestion_token = NULL, ingestion_expires_at = NULL,
      ingestion_error = NULL, updated_at = unixepoch()
    WHERE test_id = ${testId} AND ingestion_token = ${token}
      AND publication_state = 'staging' AND ingestion_expires_at >= unixepoch()
      AND EXISTS (
        SELECT 1 FROM telescope_attempts a
        JOIN telescope_jobs j ON j.id = a.job_id AND j.active_attempt_id = a.id
        JOIN telescope_agents g ON g.id = a.agent_id
        WHERE a.id = ${guard.attemptId} AND a.job_id = ${guard.jobId}
          AND a.agent_id = ${guard.agentId} AND a.result_id = ${testId}
          AND a.session_id = ${guard.sessionId} AND g.session_id = ${guard.sessionId}
          AND a.lease_hash = ${guard.leaseHash} AND a.lease_until >= ${Date.now()}
          AND g.status <> 'revoked'
      )`
    : await prisma.$executeRaw`
    UPDATE tests SET publication_state = 'committed',
      artifact_manifest = ${JSON.stringify(files)},
      original_zip_key = ${originalZipKey ?? null}, content_rating = ${rating},
      ingestion_token = NULL, ingestion_expires_at = NULL,
      ingestion_error = NULL, updated_at = unixepoch()
    WHERE test_id = ${testId} AND ingestion_token = ${token}
      AND publication_state = 'staging' AND ingestion_expires_at >= unixepoch()`;
  if (changed !== 1)
    throw new Error('Ingestion ownership changed before publication');
}

/** Hide partial writes while retaining a bounded diagnostic for upload recovery. */
export async function failIngestion(
  prisma: PrismaClient,
  testId: string,
  token: string,
  error: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE tests SET publication_state = 'failed',
      ingestion_error = ${error.slice(0, 2000)}, ingestion_token = NULL,
      ingestion_expires_at = NULL, updated_at = unixepoch()
    WHERE test_id = ${testId} AND ingestion_token = ${token}
      AND publication_state = 'staging'`;
}
