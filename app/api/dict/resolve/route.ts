/**
 * `POST /api/dict/resolve { words: string[] }` — the list importer's lookup.
 *
 * POST rather than GET because a pasted list is hundreds of words, which do not
 * fit in a URL. The rule is `lib/dict/resolve.ts`; this is transport, and like
 * every other dictionary route it answers a missing `data/` build with a 503 so
 * the shell can show one banner.
 */
import { withDictDiagnostics } from '@/lib/dict/diagnostics';
import { dictErrorResponse } from '@/lib/dict/load';
import {
  RESOLVE_MAX_WORD_CHARS,
  RESOLVE_MAX_WORDS,
  resolveWords,
  type ResolveResult,
} from '@/lib/dict/resolve';

// The dictionary is read from disk per process; never prerender this at build time.
export const dynamic = 'force-dynamic';

const BAD_REQUEST = { error: 'bad-request', hint: 'send JSON { words: string[] }' };

export const POST = withDictDiagnostics(async function handlePost(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(BAD_REQUEST, { status: 400 });
  }

  const words = (payload as { words?: unknown } | null)?.words;
  if (!Array.isArray(words) || words.length === 0) {
    return Response.json(BAD_REQUEST, { status: 400 });
  }
  if (words.length > RESOLVE_MAX_WORDS) {
    return Response.json(
      { error: 'too-many-words', hint: `at most ${RESOLVE_MAX_WORDS} words per request` },
      { status: 400 },
    );
  }
  if (!words.every((word) => typeof word === 'string' && word.length <= RESOLVE_MAX_WORD_CHARS)) {
    return Response.json(
      { error: 'bad-request', hint: `every word must be a string of at most ${RESOLVE_MAX_WORD_CHARS} characters` },
      { status: 400 },
    );
  }

  try {
    const body: ResolveResult = resolveWords(words as string[]);
    return Response.json(body);
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }
});
