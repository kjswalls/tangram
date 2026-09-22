/**
 * The ask module's state, as the UI sees it (docs/plans/core.md C7; declared
 * here at C1).
 *
 * **This file is C7's and this is its types-only first commit**, which is the
 * pattern CLAUDE.md's "shared surfaces" rule asks for: the owner lands the
 * declarations alone and siblings gate on the commit rather than the phase. C1
 * needs the names to render three gallery entries with stable test ids, C4's
 * in-context gloss line consumes `unavailable`, and C7 builds the real panel.
 * Nothing here is an implementation and nothing here is a wire format.
 *
 * Five states, and the last two are the ones that matter (product-decisions §5,
 * core.md R9):
 *
 * - `idle` — nothing asked.
 * - `thinking` — the model call is out. **The dictionary card is already
 *   rendered and already addable**; the answer never blocks the add.
 * - `answered` — `backend.md` B2 fills this in, and changes none of the other
 *   four. It is the only state whose payload is a wire concern.
 * - `unavailable` — no AI is reachable. A *reachability* fact, not a wire-format
 *   fact, which is why it is renderable and testable before B2 settles
 *   anything. The chip reads "Dictionary only — offline" and everything else
 *   works.
 * - `ungrounded` — the answer arrived and **nothing in it could be checked
 *   against a cited dictionary row**. This is the visible face of PLAN.md
 *   §3.4's grounding contract and it is distinct from "no answer": one is the
 *   model saying nothing useful, the other is grounding rejecting everything it
 *   said. It renders an `EmptyState`, not an empty answer body — and per §5 the
 *   real words inside the rejected phrases stay addable.
 */

/**
 * Why no model could be reached. The chip does not have to show it.
 *
 * `not-configured` is the one reason that is not about this request: the build
 * has no API at all (`API_CONFIGURED`, `lib/api/availability.ts`). `offline`
 * and `timeout` are the panel's "unreachable" pair, the two that earn a retry.
 */
export type AskUnavailableReason =
  | 'offline'
  | 'no-key'
  | 'server'
  | 'rate-limited'
  | 'timeout'
  | 'not-configured';

export type AskStateName = 'idle' | 'thinking' | 'answered' | 'unavailable' | 'ungrounded';

export interface AskIdle {
  name: 'idle';
}
export interface AskThinking {
  name: 'thinking';
}
export interface AskUnavailable {
  name: 'unavailable';
  reason: AskUnavailableReason;
}
export interface AskUngrounded {
  name: 'ungrounded';
  /**
   * How many proposals grounding rejected. Zero is legal — a model that
   * proposed nothing at all — and the copy does not depend on the number.
   */
  rejected: number;
}
export interface AskAnswered<TAnswer = unknown> {
  name: 'answered';
  /** `backend.md` B2's grounded payload. Opaque to every consumer but C7. */
  answer: TAnswer;
}

export type AskState<TAnswer = unknown> =
  | AskIdle
  | AskThinking
  | AskAnswered<TAnswer>
  | AskUnavailable
  | AskUngrounded;

/** The chip's words, stated once. C1's gallery and C7's panel render the same string. */
export const ASK_OFFLINE_CHIP = 'Dictionary only — offline';

/** The `ungrounded` empty state's words, likewise. */
export const ASK_UNGROUNDED_TITLE = 'Nothing here could be checked';
export const ASK_UNGROUNDED_BODY =
  'The answer did not cite a dictionary entry this app could verify, so none of it is shown. ' +
  'The dictionary result above is unaffected.';

/**
 * No API in this build (`web.md`, the no-API phase). A different chip from the
 * offline one on purpose: "offline" promises that coming back online helps, and
 * here nothing the learner does will.
 */
export const ASK_NOT_CONFIGURED_CHIP = 'Dictionary only';
export const ASK_NOT_CONFIGURED_BODY =
  'AI answers are not set up in this version of the app. The dictionary works as normal.';

/** A base is set and nothing answered. Transient, so it comes with a retry. */
export const ASK_UNREACHABLE_BODY = 'Could not reach the AI server.';
export const ASK_RETRY_LABEL = 'Try again';
