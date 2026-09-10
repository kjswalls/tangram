/**
 * `GET /api/dict/entries?ids=<id>[,<id>…]` (PLAN.md §3.2).
 *
 * Ids may also be repeated as separate `ids` params. Entries come back in the order
 * asked for; ids that are not in the dictionary are dropped rather than erroring, so
 * a stale card snapshot degrades to "not found" instead of failing the whole batch.
 */
import { withDictDiagnostics } from '@/lib/dict/diagnostics';
import { dictErrorResponse } from '@/lib/dict/load';
import { dictVersion, getEntries, parseIdList } from '@/lib/dict/index';
import type { EntriesResponse } from '@/lib/dict/types';

// The dictionary is read from disk per process; never prerender this at build time.
export const dynamic = 'force-dynamic';

const MAX_IDS = 200;

export const GET = withDictDiagnostics(function handleGet(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const ids = params.getAll('ids').flatMap(parseIdList);

  if (ids.length === 0) {
    return Response.json(
      { error: 'bad-request', hint: 'pass ?ids=<entry id>, comma-separated or repeated' },
      { status: 400 },
    );
  }
  if (ids.length > MAX_IDS) {
    return Response.json(
      { error: 'too-many-ids', hint: `at most ${MAX_IDS} ids per request` },
      { status: 400 },
    );
  }

  try {
    const body: EntriesResponse = { meta: { version: dictVersion() }, entries: getEntries(ids) };
    return Response.json(body);
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }
});
