/**
 * `POST /api/recall` (PLAN.md §4, Phase 6 item 2) — read a typed answer against
 * an entry's glosses and *suggest* a grade.
 *
 *   { entry, senseIndex?, answer }  →  { suggested: 1|2|3|4, why, provider }
 *
 * **The route `backend.md` B2 flips least.** It always needed one thing from
 * the dictionary — the entry's glosses — and after the flip the client sends
 * them instead of sending an id for the server to look up. Everything else is
 * as it was.
 *
 * What the route guarantees, on top of the provider's answer:
 *
 *  - **The grade is one of four numbers.** `gradeRecallSchema` rejects anything
 *    else, and a provider that returns a 7 (or a string, or nothing) is a 502
 *    rather than an unhighlightable button.
 *  - **The reason is plain English.** `why` goes through `scrubProse`
 *    (`packages/ai/ground.ts`) — the same scrubber `interpretation` and `notes`
 *    use, not a second copy of it — so no hanzi and no pinyin reach the card
 *    front. **This one stays on the server** even though grounding moved:
 *    scrubbing `why` is not a rendering concern, it is what stops an unchecked
 *    reading reaching the card front, and it costs nothing to do it where the
 *    model output is first seen. `asRecallSuggestion` scrubs it again on the
 *    client, which is deliberate — the promise is about what a learner is
 *    shown, not about what one route returns.
 *  - **It answers, or it fails cleanly.** A hung provider is a 502 after
 *    `TANGRAM_RECALL_TIMEOUT_MS` and a malformed body is a 400. The client
 *    treats every failure identically — no suggestion — because the card has
 *    already flipped and the four buttons are live either way.
 *
 * There is no 404 and no 503 any more: this server has no dictionary, so it can
 * neither miss one nor fail to find an id in it. An entry the dictionary does
 * not have cannot be sent, because the caller reads it off the card's own
 * snapshot (`lib/db/schema.ts`) — which is also why free recall keeps working
 * on a device that has never downloaded the dictionary.
 *
 * Nothing here writes anything. The suggestion is a highlight; the grade is
 * written by the learner in `useReviewStore.grade` and nowhere else.
 */

import { withDeadline } from '@tangram/ai/deadline';
import { scrubProse } from '@tangram/ai/ground';
import { oneLine } from '@tangram/ai/recall';
import {
  gradeRecallSchema,
  ProviderError,
  selectProvider,
  type LLMProvider,
} from '@tangram/ai/provider';
import type { RecallResponse, RetrievedEntry } from '@tangram/ai/schemas';
import { requireAccess } from '@tangram/access';
import { deadlineMs } from '../config.ts';
import { redactString } from '../log.ts';
import { parsed, recallRequestSchema } from '../wire.ts';

/**
 * A person is waiting on this with a flipped card in front of them, so the
 * deadline is well under the ask's 30 s: past about this long the suggestion has
 * missed the moment it was for. 15 s, in `DEADLINE_DEFAULTS` (`src/config.ts`)
 * with the other three, and overridable by env — which is what lets a test
 * prove the deadline exists without waiting for it.
 */

/**
 * The grading half, with the provider passed in, so a test can hand it one that
 * throws, hangs, or answers with hanzi in the prose — the three things the
 * route exists to absorb.
 */
export async function gradeRecallWith(
  provider: LLMProvider,
  entry: RetrievedEntry,
  answer: string,
  senseIndex?: number,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await withDeadline(
      provider.gradeRecall(entry, answer, senseIndex),
      deadlineMs('recall'),
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
      { error: 'provider-failed', provider: provider.name, hint: redactString(message) },
      { status: 502 },
    );
  }

  const result = gradeRecallSchema.safeParse(raw);
  if (!result.success) {
    return Response.json(
      {
        error: 'provider-invalid',
        provider: provider.name,
        hint: redactString(
          `the grade did not match the schema: ${result.error.issues[0]?.message ?? 'unknown'}`,
        ),
      },
      { status: 502 },
    );
  }

  const body: RecallResponse = {
    suggested: result.data.suggested,
    why: oneLine(scrubProse(result.data.why)),
    provider: provider.name,
  };
  return Response.json(body);
}

/**
 * The access gate (`@tangram/access`). A no-op unless `TANGRAM_ACCESS_SECRET`
 * is set; when it is, this route costs money and answers nothing without the
 * `X-Tangram-Access` header. `app.ts` refuses the same request one layer
 * earlier, by prefix; the check staying here is what makes a missing front
 * layer a redundancy rather than a hole.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAccess(request);
  if (denied) return denied;

  const body = await parsed(
    request,
    recallRequestSchema,
    'send JSON { entry, senseIndex?, answer }',
  );
  if (!body.ok) return body.response;
  const { entry, senseIndex, answer } = body.body;

  return gradeRecallWith(selectProvider(), entry, answer, senseIndex);
}
