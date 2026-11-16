import { env } from 'cloudflare:workers';
import { z } from 'zod';

import type { APIRoute } from 'astro';
import { hasAllowedOrigin, isAdminRequest } from '@/lib/auth';
import {
  forwardingEnabled,
  listForwarding,
  processForwarding,
  scheduleForward,
  trustedForwardProvenance,
} from '@/lib/forwarding/service';
import type { ForwardingDelivery } from '@/lib/forwarding/types';
import { TestSource } from '@/lib/types/tests';
import {
  ingestResultArchive,
  IngestionError,
  readRequestBody,
  sha256,
} from '@/lib/storage/resultStore';
import { MAX_ARCHIVE_BYTES } from '@/lib/utils/security';

const UploadSchema = z.object({
  file: z.instanceof(File),
  name: z.string().trim().max(256).optional(),
  description: z.string().max(10_000).optional(),
  source: z.enum(TestSource),
  visibility: z.enum(['public', 'private']).default('public'),
});

/** Accept an archive only after its locally required files are durably stored. */
export const POST: APIRoute = async context => {
  try {
    if (!hasAllowedOrigin(context.request)) {
      return Response.json(
        { error: 'Cross-origin upload rejected' },
        { status: 403 },
      );
    }
    const body = await readRequestBody(
      context.request,
      MAX_ARCHIVE_BYTES + 64 * 1024,
    );
    const boundedRequest = new Request(context.request.url, {
      method: 'POST',
      headers: context.request.headers,
      body: new Uint8Array(body).buffer,
    });
    let form: FormData;
    try {
      form = await boundedRequest.formData();
    } catch {
      throw new IngestionError('Expected a valid multipart upload');
    }
    const upload = UploadSchema.safeParse({
      file: form.get('file'),
      name: form.get('name') ?? undefined,
      description: form.get('description') ?? undefined,
      source: form.get('source') ?? TestSource.API,
      visibility: form.get('visibility') ?? 'public',
    });
    if (!upload.success) {
      return Response.json(
        { error: upload.error.issues.map(issue => issue.message).join(', ') },
        { status: 400 },
      );
    }
    if (upload.data.file.size > MAX_ARCHIVE_BYTES) {
      throw new IngestionError(
        `ZIP exceeds the ${MAX_ARCHIVE_BYTES}-byte limit`,
        413,
      );
    }
    if (
      upload.data.visibility === 'private' &&
      !(await isAdminRequest(context.request, env))
    ) {
      return Response.json(
        {
          error: 'Administrator authentication is required for private uploads',
        },
        { status: 401 },
      );
    }
    const { file, name, description, source, visibility } = upload.data;
    const archive = new Uint8Array(await file.arrayBuffer());
    const provenance = await trustedForwardProvenance(
      context.request,
      await sha256(archive),
    );
    const retainOriginal = forwardingEnabled(env) && !provenance.trusted;
    let forwarding: ForwardingDelivery | null = null;
    const receipt = await ingestResultArchive(context, archive, {
      metadata: { name, description, source },
      visibility,
      retainOriginal,
      beforeCommit: async committed => {
        forwarding = await scheduleForward(
          context,
          committed,
          {
            name,
            description,
            source,
            filename: file.name,
          },
          provenance,
        );
      },
    });
    if (context.locals.isAdmin && receipt.duplicate) {
      forwarding = (await listForwarding(env, receipt.testId, 1))[0] ?? null;
    }
    if (!receipt.duplicate && retainOriginal) {
      context.locals.cfContext.waitUntil(
        processForwarding(context).catch(error =>
          console.error('Forwarding wake-up failed:', (error as Error).message),
        ),
      );
    }
    if (receipt.duplicate) {
      return Response.json(
        {
          success: false,
          duplicate: true,
          error: 'Duplicate uploads are not allowed.',
          testId: receipt.testId,
          contentRating: receipt.contentRating,
          archiveSha256: receipt.zipKey,
          zipKey: receipt.zipKey,
          publicationState: receipt.publicationState,
          ...(context.locals.isAdmin ? { forwarding } : {}),
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return Response.json(
      {
        success: true,
        testId: receipt.testId,
        contentRating: receipt.contentRating,
        archiveSha256: receipt.zipKey,
        zipKey: receipt.zipKey,
        publicationState: receipt.publicationState,
        ...(context.locals.isAdmin ? { forwarding } : {}),
        message: 'Upload saved locally',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const known = error instanceof IngestionError;
    if (!known) console.error('Upload failed:', (error as Error).message);
    return Response.json(
      { error: known ? error.message : 'Unable to save this upload' },
      {
        status: known ? error.status : 500,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
};
