import { env } from 'cloudflare:workers';

import type { APIRoute } from 'astro';
import { IngestionError, readRequestBody } from '@/lib/storage/resultStore';
import {
  adminSessionCookie,
  clearAdminSessionCookie,
  getBindingString,
  hasAllowedOrigin,
  isAdminRequest,
  tokenMatches,
} from '@/lib/auth';

/** Report session capability without exposing the configured secret. */
export const GET: APIRoute = async ({ request }) =>
  Response.json(
    {
      configured: Boolean(getBindingString(env, 'TELESCOPE_ADMIN_TOKEN')),
      authenticated: await isAdminRequest(request, env),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );

/** Establish the HttpOnly single-administrator session. */
export const POST: APIRoute = async ({ request }) => {
  if (!hasAllowedOrigin(request))
    return Response.json(
      { error: 'Cross-origin request rejected' },
      { status: 403 },
    );
  const expected = getBindingString(env, 'TELESCOPE_ADMIN_TOKEN');
  if (!expected)
    return Response.json(
      { error: 'Administration is not configured' },
      { status: 503 },
    );
  try {
    const bytes = await readRequestBody(request, 8192);
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const token =
      body && typeof body === 'object' ? Reflect.get(body, 'token') : undefined;
    if (
      typeof token !== 'string' ||
      token.length > 4096 ||
      !(await tokenMatches(token, expected))
    ) {
      return Response.json(
        { error: 'Invalid administrator credential' },
        { status: 401 },
      );
    }
    return Response.json(
      { authenticated: true },
      {
        headers: {
          'Set-Cookie': adminSessionCookie(
            token,
            new URL(request.url).protocol === 'https:',
          ),
          'Cache-Control': 'no-store',
        },
      },
    );
  } catch (error) {
    return Response.json(
      { error: 'Invalid session request' },
      {
        status: error instanceof IngestionError ? error.status : 400,
      },
    );
  }
};

/** End the current browser session. */
export const DELETE: APIRoute = ({ request }) => {
  if (!hasAllowedOrigin(request))
    return Response.json(
      { error: 'Cross-origin request rejected' },
      { status: 403 },
    );
  return Response.json(
    { authenticated: false },
    {
      headers: {
        'Set-Cookie': clearAdminSessionCookie(
          new URL(request.url).protocol === 'https:',
        ),
        'Cache-Control': 'no-store',
      },
    },
  );
};
