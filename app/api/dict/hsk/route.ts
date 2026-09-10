/**
 * `GET /api/dict/hsk?band=<1-7>` (PLAN.md §3.2) — one HSK 3.0 band, ordered by
 * frequency. Band 7 is the list labelled "7–9"; there is no band 8 or 9.
 *
 * `HEAD` is the same route and is the **first request the app ever makes**:
 * `components/shell/data-banner.tsx` probes it on mount and reads only the status.
 * Next auto-implements HEAD from GET, so this route already answered it; exporting
 * HEAD explicitly replaces that automatic one **on this route only** and buys the
 * one thing the automatic one could not do — start the dictionary warm-up
 * (`lib/dict/warm.ts`) at the one moment in a session when nobody is waiting.
 */
import { after } from 'next/server';

import { withDictDiagnostics } from '@/lib/dict/diagnostics';
import { dictErrorResponse } from '@/lib/dict/load';
import { dictVersion, getDictIndex, hskBand } from '@/lib/dict/index';
import type { HskBand, HskResponse } from '@/lib/dict/types';
import { warmDictionary, WARM_UP_NOT_SCHEDULED } from '@/lib/dict/warm';

// The dictionary is read from disk per process; never prerender this at build time.
export const dynamic = 'force-dynamic';

/**
 * The band, or the 400 both handlers answer with.
 *
 * Shared rather than duplicated so HEAD cannot drift from GET: the banner reads
 * the status alone, so a HEAD that disagreed about which bands are valid would
 * stay invisible until the day it mattered.
 */
function parseBand(request: Request): HskBand | Response {
  const raw = new URL(request.url).searchParams.get('band');
  const band = Number(raw);
  if (!raw || !Number.isInteger(band) || band < 1 || band > 7) {
    return Response.json(
      { error: 'bad-band', hint: 'band must be an integer 1-7; 7 is the band labelled 7-9' },
      { status: 400 },
    );
  }
  return band as HskBand;
}

export const GET = withDictDiagnostics(function handleGet(request: Request): Response {
  const band = parseBand(request);
  if (band instanceof Response) return band;

  try {
    const body: HskResponse = {
      meta: { version: dictVersion() },
      band,
      entries: hskBand(band),
    };
    return Response.json(body);
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }
});

/**
 * Schedule the rest of the warm-up so it outlives this response.
 *
 * A bare dangling promise is **not** sufficient on Vercel: once the response is
 * sent, the instance can be frozen mid-promise, and the work either never finishes
 * or resumes half-done on some unrelated later request. `after()` is what hands
 * the task to the platform's `waitUntil`, which keeps the invocation alive until
 * it settles. (Under `next start` Next supplies its own awaiter, so this is the
 * same code path locally, which is what makes it measurable here.)
 *
 * `after()` throws when there is no request scope, which is what happens when the
 * handler is called directly — the unit tests do exactly that, and there is no
 * live instance to keep warm in that case, so skipping is right. It is *not* right
 * to be silent about any other reason: a runtime that supplies no `waitUntil`
 * would degrade to "the warm-up never happens", and the only symptom is a ~1.5 s
 * first lookup that nobody is measuring. Vercel captures `console.warn` per
 * invocation, so one line is the difference between a diagnosable regression and
 * an invisible one. (The message lives in lib/dict/warm.ts because a route module
 * may export only handlers and route config — Next type-checks that.)
 */
function scheduleWarmUp(): void {
  try {
    after(async () => {
      await warmDictionary();
    });
  } catch (error) {
    console.warn(WARM_UP_NOT_SCHEDULED, error);
  }
}

export const HEAD = withDictDiagnostics(function handleHead(request: Request): Response {
  const band = parseBand(request);
  // The 400 body rides along rather than being stripped here. A HEAD response
  // carries no body over the wire — Node drops it — and writing a second,
  // bodiless spelling of this answer would only create a way for the two
  // handlers' statuses to disagree.
  if (band instanceof Response) return band;

  try {
    // Only what GET's own answer needs: `sorted`, `entries`, `hsk`. The probe must
    // not become slower than the answer it stands in for, and neither this route's
    // own client wrapper (`fetchHskBand`, lib/dict/client.ts) nor anything outside
    // the app should have to queue behind ~2.3 s of index building for a 200. This
    // read is also what raises `DictDataMissingError`, the 503 the banner keys on.
    void getDictIndex().byHsk;
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }

  scheduleWarmUp();
  // The header set GET would have sent, minus the body. Next's auto-implemented
  // HEAD ran GET and stripped the body, so it carried `content-type`; a bodiless
  // 200 that quietly drops it is this route disagreeing with every other one.
  return new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });
});
