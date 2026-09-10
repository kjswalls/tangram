/**
 * `GET /api/dict/decomp?chars=<hanzi>` — Make Me a Hanzi decomposition for the
 * characters of a headword, for the lookup panel's character breakdown.
 *
 * Its own route, and its own `data/decomp.json`, because its licence differs from
 * the dictionary's (CLAUDE.md). Nothing here is ever written into a card.
 */
import { decomposeChars, type DecompResponse } from '@/lib/dict/decomp';
import { withDictDiagnostics } from '@/lib/dict/diagnostics';
import { dictErrorResponse } from '@/lib/dict/load';

// The decomposition file is read from disk per process; never prerender.
export const dynamic = 'force-dynamic';

const MAX_CHARS = 64;

export const GET = withDictDiagnostics(function handleGet(request: Request): Response {
  const chars = new URL(request.url).searchParams.get('chars');
  if (!chars) {
    return Response.json({ error: 'bad-request', hint: 'pass ?chars=<hanzi>' }, { status: 400 });
  }
  if ([...chars].length > MAX_CHARS) {
    return Response.json(
      { error: 'too-many-chars', hint: `at most ${MAX_CHARS} characters` },
      { status: 400 },
    );
  }

  try {
    const body: DecompResponse = { characters: decomposeChars(chars) };
    return Response.json(body);
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }
});
