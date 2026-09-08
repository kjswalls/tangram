/**
 * The edge half of the access gate (`lib/server/access.ts` is the other half).
 *
 * It does two things and nothing else:
 *
 *  1. **Trades a `?key=` for a cookie, on any route.** The owner tests on a
 *     phone, where there is no way to set a request header, so authorising a
 *     device is one visit to `https://<app>/?key=<secret>`. The key is checked,
 *     the cookie is set, and the request is redirected to the same URL with the
 *     key taken back out — so the secret does not stay in the address bar, in
 *     the back/forward history, in a bookmark, or in the `Referer` of the next
 *     outbound link. What is left behind is `?access=granted` or
 *     `?access=denied`, which is the only feedback a phone with no devtools can
 *     read.
 *  2. **Refuses an unauthorised request to the three paid routes**, before it
 *     reaches a handler, a provider, or a 33 MB dictionary load.
 *
 * With `TANGRAM_ACCESS_SECRET` unset it does neither: every request passes
 * straight through, which is what keeps `pnpm dev`, `pnpm test` and `pnpm e2e`
 * identical to the way they behaved before the gate existed.
 *
 * The routes check *again* for themselves (`requireAccess`). That is not
 * belt-and-braces for its own sake: middleware is one `matcher` edit away from
 * silently not running, and the failure mode of a gate that quietly stopped
 * matching is an invoice.
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  ACCESS_QUERY_PARAM,
  ACCESS_RESULT_PARAM,
  accessCookie,
  accessSecret,
  clearAccessCookie,
  constantTimeEqual,
  GATED_PATHS,
  isAuthorizedRequest,
  unauthorizedResponse,
} from '@/lib/server/access';

export const config = {
  /**
   * Everything except the assets that are served straight off disk and can
   * never be gated: the hashed build output, the images Next optimises, the
   * service worker, its manifest and its offline page. `?key=` is only ever
   * typed against a page URL, and the gated routes are all under `/api/`.
   */
  matcher: ['/((?!_next/static|_next/image|sw\\.js|offline\\.html|manifest\\.webmanifest).*)'],
};

/** Is `pathname` one of the gated routes (or something nested under one)? */
function isGated(pathname: string): boolean {
  return GATED_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function middleware(request: NextRequest): Response {
  const secret = accessSecret();
  if (secret === null) return NextResponse.next();

  const url = request.nextUrl;
  const presented = url.searchParams.get(ACCESS_QUERY_PARAM);

  if (presented !== null) {
    const target = url.clone();
    target.searchParams.delete(ACCESS_QUERY_PARAM);
    const cookie = accessCookie(secret, { secure: url.protocol === 'https:' });

    if (!constantTimeEqual(presented, secret)) {
      target.searchParams.set(ACCESS_RESULT_PARAM, 'denied');
      const response = NextResponse.redirect(target, 303);
      // A wrong key on a device that was already authorised revokes it. The
      // alternative — ignoring the attempt — means a shared phone stays
      // authorised after the owner has tried to hand it a new key.
      response.headers.append('set-cookie', clearAccessCookie({ secure: url.protocol === 'https:' }));
      return response;
    }

    if (cookie === null) {
      // The secret is right but cannot be written into a cookie value. Saying
      // so beats issuing an encoded cookie that no longer equals the secret.
      target.searchParams.set(ACCESS_RESULT_PARAM, 'unusable');
      return NextResponse.redirect(target, 303);
    }

    target.searchParams.set(ACCESS_RESULT_PARAM, 'granted');
    const response = NextResponse.redirect(target, 303);
    response.headers.append('set-cookie', cookie);
    return response;
  }

  if (isGated(url.pathname) && !isAuthorizedRequest(request)) {
    return unauthorizedResponse();
  }

  return NextResponse.next();
}
