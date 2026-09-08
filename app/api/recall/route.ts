/**
 * `POST /api/recall` (PLAN.md §4, Phase 6 item 2) — read a typed answer against
 * an entry's glosses and *suggest* a grade.
 *
 *   { entryId, senseIndex?, answer }  →  { suggested: 1|2|3|4, why, provider }
 *
 * What the route guarantees, on top of the provider's answer:
 *
 *  - **The grade is one of four numbers.** `gradeRecallSchema` rejects anything
 *    else, and a provider that returns a 7 (or a string, or nothing) is a 502
 *    rather than an unhighlightable button.
 *  - **The reason is plain English.** `why` goes through `scrubProse`
 *    (`lib/ai/ground.ts`) — the same scrubber `interpretation` and `notes` use,
 *    not a second copy of it — so no hanzi and no pinyin reach the card front.
 *    A learner cannot detect a wrong tone (§1, commitment 3), and a reason that
 *    quotes the reading is a reading nobody checked.
 *  - **It answers, or it fails cleanly.** A hung provider is a 502 after
 *    `RECALL_TIMEOUT_MS`, a missing `data/` build is the same
 *    `503 {error:'dict-data-missing'}` every dictionary route gives, and an
 *    entry the dictionary does not have is a 404. The client treats all of them
 *    identically — no suggestion — because the card has already flipped and the
 *    four buttons are live either way.
 *
 * Nothing here writes anything. The suggestion is a highlight; the grade is
 * written by the learner in `useReviewStore.grade` and nowhere else.
 */

import { scrubProse } from '@/lib/ai/ground';
import { oneLine, RECALL_ANSWER_MAX_CHARS } from '@/lib/ai/recall';
import {
  gradeRecallSchema,
  ProviderError,
  selectProvider,
  type LLMProvider,
  type ProviderName,
} from '@/lib/ai/provider';
import { getEntry } from '@/lib/dict/index';
import { dictErrorResponse } from '@/lib/dict/load';
import type { Entry } from '@/lib/types';

// The dictionary is read from disk per process; never prerender this at build time.
export const dynamic = 'force-dynamic';

/**
 * A person is waiting on this with a flipped card in front of them, so the
 * deadline is well under the ask's 30 s: past about this long the suggestion has
 * missed the moment it was for. Overridable by env, which is what lets a test
 * prove the deadline exists without waiting for it.
 */
export const RECALL_TIMEOUT_MS = 15_000;

function timeoutMs(): number {
  const raw = Number(process.env.TANGRAM_RECALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : RECALL_TIMEOUT_MS;
}

export interface RecallRouteResponse {
  suggested: 1 | 2 | 3 | 4;
  /** One line of plain prose. Scrubbed of CJK and pinyin. */
  why: string;
  provider: ProviderName;
}

interface RecallRequestBody {
  entryId: string;
  senseIndex?: number;
  answer: string;
}

function badRequest(hint: string): Response {
  return Response.json({ error: 'bad-request', hint }, { status: 400 });
}

/**
 * The body, or the reason it is not one.
 *
 * An out-of-range or non-integer `senseIndex` is dropped rather than rejected:
 * it names which gloss the card is about, and the honest fallback for "I cannot
 * tell" is to judge the answer against all of them. A missing answer *is*
 * rejected — the client never sends one (an empty box asks nobody, see
 * `lib/ai/recall.ts`), so an empty answer here is a caller bug worth naming.
 */
export function parseRecallBody(payload: unknown): RecallRequestBody | string {
  if (typeof payload !== 'object' || payload === null) {
    return 'send JSON { entryId, senseIndex?, answer }';
  }
  const body = payload as Record<string, unknown>;

  const entryId = typeof body.entryId === 'string' ? body.entryId.trim() : '';
  if (!entryId) return 'pass a non-empty { entryId }';

  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  if (!answer) return 'pass a non-empty { answer }';
  if (answer.length > RECALL_ANSWER_MAX_CHARS) {
    return `answer is at most ${RECALL_ANSWER_MAX_CHARS} characters`;
  }

  const raw = body.senseIndex;
  const senseIndex = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;

  return { entryId, answer, ...(senseIndex === undefined ? {} : { senseIndex }) };
}

/**
 * Reject when the provider has not answered in time. The provider interface
 * takes no `AbortSignal`, so this is a race: the call may still be in flight,
 * but nobody is waiting on it any more. `/api/ask` keeps its own private copy
 * of this helper; lifting the two into `lib/ai` would mean editing that route,
 * which belongs to another builder this week — the merge can fold them.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The grading half, with the provider passed in, so a test can hand it one that
 * throws, hangs, or answers with hanzi in the prose — the three things the
 * route exists to absorb.
 */
export async function gradeRecallWith(
  provider: LLMProvider,
  entry: Entry,
  answer: string,
  senseIndex?: number,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await withTimeout(
      provider.gradeRecall(entry, answer, senseIndex),
      timeoutMs(),
      'the grade',
    );
  } catch (error) {
    const message =
      error instanceof ProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'the provider failed';
    return Response.json(
      { error: 'provider-failed', provider: provider.name, hint: message },
      { status: 502 },
    );
  }

  const parsed = gradeRecallSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: 'provider-invalid',
        provider: provider.name,
        hint: `the grade did not match the schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      },
      { status: 502 },
    );
  }

  const body: RecallRouteResponse = {
    suggested: parsed.data.suggested,
    why: oneLine(scrubProse(parsed.data.why)),
    provider: provider.name,
  };
  return Response.json(body);
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest('send JSON { entryId, senseIndex?, answer }');
  }

  const parsedBody = parseRecallBody(payload);
  if (typeof parsedBody === 'string') return badRequest(parsedBody);
  const { entryId, answer, senseIndex } = parsedBody;

  let entry: Entry | undefined;
  try {
    entry = getEntry(entryId);
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }
  if (!entry) {
    return Response.json(
      { error: 'unknown-entry', hint: 'that entry is not in this dictionary build' },
      { status: 404 },
    );
  }

  return gradeRecallWith(selectProvider(), entry, answer, senseIndex);
}
