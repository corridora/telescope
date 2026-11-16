import { z } from 'zod';

import type { ResultManifest } from './types.js';

export const RESULT_FORMAT_VERSION = 1 as const;

export const TestIdSchema = z
  .string()
  .regex(
    /^\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    'Invalid Telescope capture ID',
  );

export const ArtifactPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(value => {
    const parts = value.split('/');
    return (
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.includes(':') &&
      parts.every(part => part !== '' && part !== '.' && part !== '..')
    );
  }, 'Artifact paths must stay inside the capture directory');

export const ArtifactDescriptorSchema = z.object({
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const IdentityManifestSchema = z.object({
  schemaVersion: z.literal(RESULT_FORMAT_VERSION),
  testId: TestIdSchema,
});

export const ScenarioManifestSchema = z
  .object({
    schemaVersion: z.literal(RESULT_FORMAT_VERSION),
    name: z.string().max(256).optional(),
    status: z.enum([
      'running',
      'passed',
      'failed',
      'cancelled',
      'interrupted',
      'dry',
    ]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    durationMs: z.number().nonnegative(),
    error: z.string().optional(),
    coverStepId: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    video: z
      .object({
        path: ArtifactPathSchema,
        startOffsetMs: z.number().finite().optional(),
      })
      .optional(),
    steps: z
      .array(
        z.object({
          id: z.string().regex(/^\d{4}$/),
          order: z.number().int().nonnegative(),
          name: z.string().trim().min(1).max(256),
          kind: z.enum(['navigation', 'interaction']),
          status: z.enum([
            'pending',
            'running',
            'passed',
            'failed',
            'skipped',
            'cancelled',
          ]),
          artifactBase: ArtifactPathSchema,
          metricScope: z.enum(['navigation', 'interval']),
          startingUrl: z.string().optional(),
          endingUrl: z.string().optional(),
          startOffsetMs: z.number().nonnegative().optional(),
          durationMs: z.number().nonnegative().optional(),
          documentTimeOrigin: z.number().nonnegative().optional(),
          error: z.string().optional(),
          artifacts: z
            .record(ArtifactPathSchema, ArtifactDescriptorSchema)
            .optional(),
          media: z
            .object({
              status: z.enum(['available', 'unavailable']),
              reason: z.string().max(2048).optional(),
              videoPath: ArtifactPathSchema.optional(),
              frameRate: z.number().finite().positive().optional(),
              frames: z
                .array(
                  z.object({
                    path: ArtifactPathSchema,
                    ms: z.number().finite().nonnegative(),
                  }),
                )
                .max(1000)
                .optional(),
              alignment: z
                .object({
                  method: z.literal('color-calibration'),
                  uncertaintyMs: z.number().finite().nonnegative(),
                  videoStartMs: z.number().finite().nonnegative(),
                })
                .optional(),
            })
            .optional(),
        }),
      )
      .min(1)
      .max(9999),
  })
  .superRefine((scenario, context) => {
    const ids = new Set<string>();
    for (const [index, step] of scenario.steps.entries()) {
      if (
        ids.has(step.id) ||
        step.artifactBase !== `steps/${step.id}` ||
        step.order !== index ||
        (step.kind === 'interaction') !== (step.metricScope === 'interval')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index],
          message:
            'Steps need unique ordered IDs, matching artifact directories, and consistent metric scopes',
        });
      }
      if (step.media) {
        const mediaPaths = [
          step.media.videoPath,
          ...(step.media.frames ?? []).map(frame => frame.path),
        ].filter((value): value is string => value !== undefined);
        if (
          mediaPaths.some(
            value => !value.startsWith(`${step.artifactBase}/`),
          ) ||
          (step.media.status === 'available' &&
            (!step.media.alignment ||
              mediaPaths.length === 0 ||
              step.startOffsetMs === undefined ||
              step.durationMs === undefined)) ||
          mediaPaths.some(
            value =>
              !step.artifacts?.[value.slice(step.artifactBase.length + 1)],
          ) ||
          step.media.frames?.some(
            (frame, frameIndex, frames) =>
              (frameIndex > 0 && frame.ms < frames[frameIndex - 1].ms) ||
              (step.durationMs !== undefined && frame.ms > step.durationMs),
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', index, 'media'],
            message:
              'Step media needs scoped artifact descriptors, ordered frame times, and a measured alignment',
          });
        }
      }
      ids.add(step.id);
    }
  });

export const ResultManifestSchema: z.ZodType<ResultManifest> = z.object({
  schemaVersion: z.literal(RESULT_FORMAT_VERSION),
  testId: TestIdSchema,
  status: z.enum([
    'running',
    'passed',
    'failed',
    'cancelled',
    'interrupted',
    'dry',
  ]),
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
  ScenarioStepMedia,
  ScenarioStepResult,
} from './types.js';
