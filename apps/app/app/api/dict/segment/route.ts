/**
 * `POST /api/dict/segment { text }` (PLAN.md §3.2).
 *
 * POST rather than GET because the reader posts whole paragraphs, which do not
 * belong in a URL or in a server log. The algorithm is `lib/dict/segment.ts`.
 */
import { dictErrorResponse } from '@/lib/dict/load';
import { segment, type SegmentResult, type SegmentScript } from '@/lib/dict/segment';

// The dictionary is read from disk per process; never prerender this at build time.
export const dynamic = 'force-dynamic';

const MAX_TEXT_CHARS = 20_000;

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'bad-request', hint: 'send JSON { text }' }, { status: 400 });
  }

  const body = payload as { text?: unknown; script?: unknown } | null;
  const text = body?.text;
  if (typeof text !== 'string') {
    return Response.json({ error: 'bad-request', hint: 'send JSON { text }' }, { status: 400 });
  }
  if (text.length > MAX_TEXT_CHARS) {
    return Response.json(
      { error: 'text-too-long', hint: `at most ${MAX_TEXT_CHARS} characters` },
      { status: 400 },
    );
  }
  const script = body?.script === 'simp' || body?.script === 'trad' ? (body.script as SegmentScript) : undefined;

  try {
    const result: SegmentResult = segment(text, script ? { script } : {});
    return Response.json(result);
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }
}
