/**
 * `GET /api/dict/search?q=<query>&cursor=<cursor>` (PLAN.md §3.2).
 *
 * Routing and ranking live in `lib/dict/search.ts`; this is transport. Like the
 * other dictionary routes it answers a missing `data/` build with 503 rather than
 * a stack trace, so the shell can show one banner.
 */
import { dictErrorResponse } from '@/lib/dict/load';
import { search, SEARCH_PAGE_SIZE, type SearchResult } from '@/lib/dict/search';

// The dictionary is read from disk per process; never prerender this at build time.
export const dynamic = 'force-dynamic';

const MAX_QUERY_CHARS = 200;

export function GET(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const q = params.get('q');
  if (q === null || q.trim() === '') {
    return Response.json(
      { error: 'bad-request', hint: 'pass ?q=<query>' },
      { status: 400 },
    );
  }
  if (q.length > MAX_QUERY_CHARS) {
    return Response.json(
      { error: 'query-too-long', hint: `at most ${MAX_QUERY_CHARS} characters` },
      { status: 400 },
    );
  }

  const rawLimit = Number(params.get('limit') ?? SEARCH_PAGE_SIZE);
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, SEARCH_PAGE_SIZE) : SEARCH_PAGE_SIZE;

  try {
    const body: SearchResult = search(q, { limit, cursor: params.get('cursor') ?? undefined });
    return Response.json(body);
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }
}
