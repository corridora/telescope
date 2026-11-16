import { z } from 'zod';

import type { ResultManifest } from './types.js';

export const RESULT_FORMAT_VERSION = 1 as const;

export const TestIdSchema = z.string().regex(
  /^\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  'Invalid Telescope capture ID',
);

export const ArtifactPathSchema = z.string().min(1).max(512).refine(value => {
  const parts = value.split('/');
  return !value.includes('\\') && !value.includes('\0') &&
    !value.includes(':') && parts.every(part => part !== '' && part !== '.' && part !== '..');
}, 'Artifact paths must stay inside the capture directory');

export const ArtifactDescriptorSchema = z.object({
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const IdentityManifestSchema = z.object({
  schemaVersion: z.literal(RESULT_FORMAT_VERSION),
  testId: TestIdSchema,
});

export const ScenarioManifestSchema = z.object({
  schemaVersion: z.literal(RESULT_FORMAT_VERSION),
  name: z.string().max(256).optional(),
  status: z.enum(['running', 'passed', 'failed', 'cancelled', 'interrupted', 'dry']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
  coverStepId: z.string().regex(/^\d{4}$/).optional(),
  video: z.object({path: ArtifactPathSchema, startOffsetMs: z.number().nonnegative()}).optional(),
  steps: z.array(z.object({
    id: z.string().regex(/^\d{4}$/),
    order: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(256),
    kind: z.enum(['navigation', 'interaction']),
    status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'cancelled']),
    artifactBase: ArtifactPathSchema,
    metricScope: z.enum(['navigation', 'interval']),
    startingUrl: z.string().optional(),
    endingUrl: z.string().optional(),
    startOffsetMs: z.number().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    documentTimeOrigin: z.number().nonnegative().optional(),
    error: z.string().optional(),
    artifacts: z.record(ArtifactPathSchema, ArtifactDescriptorSchema).optional(),
  })).min(1).max(9999),
}).superRefine((scenario, context) => {
  const ids = new Set<string>();
  for (const [index, step] of scenario.steps.entries()) {
    if (ids.has(step.id) || step.artifactBase !== `steps/${step.id}` || step.order !== index) {
      context.addIssue({code: z.ZodIssueCode.custom, path: ['steps', index], message: 'Steps need unique ordered IDs and matching artifact directories'});
    }
    ids.add(step.id);
  }
});

export const ResultManifestSchema: z.ZodType<ResultManifest> = z.object({
  schemaVersion: z.literal(RESULT_FORMAT_VERSION),
  testId: TestIdSchema,
  status: z.enum(['running', 'passed', 'failed', 'cancelled', 'interrupted', 'dry']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  artifacts: z.record(ArtifactPathSchema, ArtifactDescriptorSchema),
});

/** Validates portable capture metadata without importing browser/CLI code. */
export function parseResultManifest(value: unknown): ResultManifest {
  return ResultManifestSchema.parse(value);
}

export type {
  ArtifactDescriptor,
  IdentityManifest,
  ResultManifest,
  RunPhase,
  RunProgress,
  RunStatus,
  ScenarioManifest,
  ScenarioStepResult,
} from './types.js';
