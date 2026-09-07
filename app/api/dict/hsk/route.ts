/**
 * `GET /api/dict/hsk?band=<1-7>` (PLAN.md §3.2) — one HSK 3.0 band, ordered by
 * frequency. Band 7 is the list labelled "7–9"; there is no band 8 or 9.
 */
import { dictErrorResponse } from '@/lib/dict/load';
import { dictVersion, hskBand } from '@/lib/dict/index';
import type { HskBand, HskResponse } from '@/lib/dict/types';

// The dictionary is read from disk per process; never prerender this at build time.
export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  const raw = new URL(request.url).searchParams.get('band');
  const band = Number(raw);
  if (!raw || !Number.isInteger(band) || band < 1 || band > 7) {
    return Response.json(
      { error: 'bad-band', hint: 'band must be an integer 1-7; 7 is the band labelled 7-9' },
      { status: 400 },
    );
  }

  try {
    const body: HskResponse = {
      meta: { version: dictVersion() },
      band: band as HskBand,
      entries: hskBand(band as HskBand),
    };
    return Response.json(body);
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }
}
