import { env } from 'cloudflare:workers';
import { Zip, ZipPassThrough } from 'fflate';

import type { APIRoute } from 'astro';
import { ContentRating } from '@/lib/types/tests';
import { checkTestRating } from '@/lib/utils/contentRatingCache';
import { isValidTestId } from '@/lib/utils/security';
import { createResultStore } from '@/lib/storage/resultStore';

/** Streams a portable archive without buffering all videos and artifacts in memory. */
export const GET: APIRoute = async context => {
  const { testId } = context.params;
  if (!testId || !isValidTestId(testId))
    return new Response('Invalid test ID', { status: 400 });
  if (
    env.ENABLE_AI_RATING === 'true' &&
    (await checkTestRating(context, testId)) !== ContentRating.SAFE
  ) {
    return new Response('Test file not available', { status: 404 });
  }
  const store = createResultStore();
  const names = await store.list(testId);
  if (!names.length) return new Response('No files found', { status: 404 });
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  let pending: Promise<void> = Promise.resolve();
  const zip = new Zip((error, bytes) => {
    if (error) pending = pending.then(() => Promise.reject(error));
    else if (bytes.length) pending = pending.then(() => writer.write(bytes));
  });
  const produce = async (): Promise<void> => {
    try {
      for (const name of names) {
        const object = await env.RESULTS_BUCKET.get(`${testId}/${name}`);
        if (!object)
          throw new Error('A result artifact became unavailable during export');
        const file = new ZipPassThrough(name);
        zip.add(file);
        const reader = object.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            file.push(chunk.value, false);
            await pending;
          }
          file.push(new Uint8Array(), true);
          await pending;
        } catch (error) {
          await reader.cancel(error).catch(() => undefined);
          throw error;
        } finally {
          reader.releaseLock();
        }
      }
      zip.end();
      await pending;
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
    }
  };
  context.locals.cfContext.waitUntil(produce());
  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${testId}.zip"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
