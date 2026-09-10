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

import { dictErrorResponse } from '@/lib/dict/load';
import { dictVersion, getDictIndex, hskBand } from '@/lib/dict/index';
import type { HskBand, HskResponse } from '@/lib/dict/types';
import { warmDictionary } from '@/lib/dict/warm';

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

export function GET(request: Request): Response {
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
}

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
 * `after()` throws when there is no request scope, which happens only when the
 * handler is called directly — the unit tests do exactly that. There is no live
 * instance to keep warm in that case, so skipping is the right answer.
 */
function scheduleWarmUp(): void {
  try {
    after(async () => {
      await warmDictionary();
    });
  } catch {
    // No request scope: not a real request, so there is nothing to warm.
  }
}

export function HEAD(request: Request): Response {
  const band = parseBand(request);
  // The 400 body rides along rather than being stripped here. A HEAD response
  // carries no body over the wire — Node drops it — and writing a second,
  // bodiless spelling of this answer would only create a way for the two
  // handlers' statuses to disagree.
  if (band instanceof Response) return band;

  try {
    // Only what GET's own answer needs: `sorted`, `entries`, `hsk`. Building the
    // rest here would make the probe slower than the GET it stands in for — and
    // Today's own `GET /api/dict/hsk` races this probe on a cold open, so that GET
    // would then queue behind ~2.3 s of index building. This read is also what
    // raises `DictDataMissingError`, which is the 503 the banner keys on.
    void getDictIndex().byHsk;
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }

  scheduleWarmUp();
  return new Response(null, { status: 200 });
}
