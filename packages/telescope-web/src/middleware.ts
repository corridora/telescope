import { defineMiddleware } from 'astro:middleware';
import { PrismaD1 } from '@prisma/adapter-d1';
import { PrismaClient } from '@/generated/prisma/client';
import { env } from 'cloudflare:workers';

import { isAdminRequest } from '@/lib/auth';
import { getTestAccess } from '@/lib/repositories/testRepository';
import { isValidTestId } from '@/lib/utils/security';

/** Keep access/publication gates ahead of every result page and artifact route. */
export const onRequest = defineMiddleware(async (context, next) => {
  // The D1 adapter belongs to this request; do not retain request I/O globally.
  const prisma = new PrismaClient({ adapter: new PrismaD1(env.TELESCOPE_DB) });
  context.locals.prisma = prisma;
  context.locals.isAdmin = await isAdminRequest(context.request, env);
  const match = /^\/(?:api\/tests|results)\/([^/]+)(?:\/|$)/.exec(
    context.url.pathname,
  );
  let privateResponse = false;
  if (match && isValidTestId(match[1])) {
    const access = await getTestAccess(prisma, match[1]);
    if (
      !access ||
      access.publication_state !== 'committed' ||
      (access.visibility === 'private' && !context.locals.isAdmin)
    ) {
      return new Response('Result not available', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    privateResponse = access.visibility === 'private';
  }
  const response = await next();
  if (
    privateResponse ||
    (context.locals.isAdmin && context.url.pathname === '/results')
  ) {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('Vary', 'Cookie, Authorization');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
});
