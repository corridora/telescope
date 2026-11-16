import { timingSafeEqual } from 'node:crypto';
import { env } from 'cloudflare:workers';

import type { APIContext } from 'astro';

const ADMIN_COOKIE = 'telescope_admin';

/** Read an optional deployment variable without duplicating generated bindings. */
export function getBindingString(
  bindings: object,
  name: string,
): string | undefined {
  const value: unknown = Reflect.get(bindings, name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Compare secret digests in constant time, including differing token lengths. */
export async function tokenMatches(
  actual: string,
  expected: string,
): Promise<boolean> {
  const encode = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode.encode(actual)),
    crypto.subtle.digest('SHA-256', encode.encode(expected)),
  ]);
  return timingSafeEqual(
    new Uint8Array(actualHash),
    new Uint8Array(expectedHash),
  );
}

/** Authenticate an instance administrator using a bearer token or HttpOnly cookie. */
export async function isAdminRequest(
  request: Request,
  bindings: object,
): Promise<boolean> {
  const expected = getBindingString(bindings, 'TELESCOPE_ADMIN_TOKEN');
  if (!expected) return false;
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ')) {
    return tokenMatches(authorization.slice(7), expected);
  }
  const cookie = request.headers
    .get('Cookie')
    ?.split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${ADMIN_COOKIE}=`));
  if (!cookie) return false;
  try {
    return tokenMatches(
      decodeURIComponent(cookie.slice(ADMIN_COOKIE.length + 1)),
      expected,
    );
  } catch {
    return false;
  }
}

/** Reject cross-origin browser mutations while allowing bearer-authenticated clients. */
export function hasAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (origin) return origin === new URL(request.url).origin;
  return (
    request.headers.get('Sec-Fetch-Site') !== 'cross-site' &&
    !request.headers.get('Cookie')
  );
}

/** Require the configured administrator before performing a privileged operation. */
export async function requireAdmin(
  context: APIContext,
): Promise<Response | null> {
  if (!getBindingString(env, 'TELESCOPE_ADMIN_TOKEN')) {
    return Response.json(
      { error: 'Configure TELESCOPE_ADMIN_TOKEN to enable administration' },
      { status: 503 },
    );
  }
  if (!(await isAdminRequest(context.request, env))) {
    return Response.json(
      { error: 'Administrator authentication required' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(context.request.method) &&
    !hasAllowedOrigin(context.request)
  ) {
    return Response.json(
      { error: 'Cross-origin request rejected' },
      { status: 403 },
    );
  }
  return null;
}

/** Build the secure cookie used by the instance's single-administrator session. */
export function adminSessionCookie(token: string, secure: boolean): string {
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${secure ? '; Secure' : ''}`;
}

/** Expire an administrator session cookie. */
export function clearAdminSessionCookie(secure: boolean): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}
