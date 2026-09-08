/**
 * Free-recall grading (PLAN.md §4, Phase 6 item 2) — the half of the feature
 * that is not React and not a route.
 *
 * The feature in one line: type what you think the word means, and the app
 * *suggests* a grade you can always override. The suggestion is the whole
 * risk, so the rule is written into the shapes here rather than left to the
 * component:
 *
 *  - **Nothing in this module can submit a grade.** `RecallState` has no field
 *    a grade could be read out of and `recallReducer` returns nothing but a
 *    state — no command, no callback, no rating. A grade is written in exactly
 *    one place in the app (`useReviewStore.grade`, reached by a key press or a
 *    button click), and a suggestion arriving from the network cannot reach it.
 *  - **A late suggestion is a stale suggestion.** Every submit carries a
 *    `requestId`; a `settled` action whose id is not the one still being waited
 *    on is the identity function on the state. That is what makes "the card
 *    moved on while the network was thinking" a no-op rather than a suggestion
 *    painted over somebody else's card.
 *  - **A failure is silence.** `requestRecallGrade` resolves to `null` for
 *    every kind of failure — HTTP error, timeout, abort, malformed body — and
 *    throws nothing. The caller flips the card and the learner grades by hand,
 *    which is what they were going to do anyway.
 *
 * The module is client-safe: it imports a *type* from `lib/ai/provider.ts`
 * (erased at build) and never the provider itself, which statically pulls in
 * both implementations. `scrubProse` comes from `lib/ai/ground.ts`, which is
 * pure and is already imported by the ask panel.
 */

import { scrubProse } from '@/lib/ai/ground';
import type { ParsedGradeRecall, ProviderName } from '@/lib/ai/provider';

/**
 * The 1–4 vocabulary, by value. `RECALL_GRADES` in `lib/ai/provider.ts` and
 * `StoredRating` in `lib/db/schema.ts` are the same four numbers; this module
 * may import neither at run time (one is server-only, the other opens a
 * database), so a unit test pins the three to each other instead.
 */
export const RECALL_GRADE_VALUES = [1, 2, 3, 4] as const;
export type RecallGradeValue = (typeof RECALL_GRADE_VALUES)[number];

/** What the route hands back, once it is believed. */
export interface RecallSuggestion {
  suggested: RecallGradeValue;
  /** One line of plain English: no hanzi, no pinyin. Scrubbed twice, see below. */
  why: string;
  /**
   * Who graded it. The route has always reported this; carrying it here is what
   * lets the box say "offline" the way the ask panel and the i+1 block do
   * (PLAN.md §3.4). `undefined` means the body did not say, which is treated as
   * "unknown", never as "live".
   */
  provider?: ProviderName;
}

/** The same cap `/api/ask` puts on a query: an answer is a sentence, not an essay. */
export const RECALL_ANSWER_MAX_CHARS = 400;

/**
 * How long the reason may run on the card front. The prompt asks for one line;
 * this is what happens when it is ignored.
 */
export const RECALL_WHY_MAX_CHARS = 320;

/**
 * The client's own deadline. Shorter than the route's, because nothing is
 * waiting on this: the card has already flipped and the four buttons are live.
 * A suggestion that has not arrived by now has missed the moment it was for.
 */
export const RECALL_CLIENT_TIMEOUT_MS = 20_000;

/** One line, trimmed and capped — a reason, not a paragraph. */
export function oneLine(text: string, max = RECALL_WHY_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/** Is this a grade the app knows? Anything else is not shown at all. */
export function isRecallGrade(value: unknown): value is RecallGradeValue {
  return RECALL_GRADE_VALUES.some((grade) => grade === value);
}

/**
 * Believe a response body, or do not.
 *
 * The route already validated the provider's answer against
 * `gradeRecallSchema` and scrubbed the prose. This runs again on the client for
 * the reason every boundary check is repeated: what arrives here is a network
 * response, and the thing being defended is a promise about what a learner is
 * shown ("no CJK in the prose", §3.4) — not a promise about what one route
 * returns.
 */
export function asRecallSuggestion(body: unknown): RecallSuggestion | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = body as Partial<ParsedGradeRecall> & { provider?: unknown };
  if (!isRecallGrade(value.suggested)) return null;
  const why = typeof value.why === 'string' ? oneLine(scrubProse(value.why)) : '';
  // A name this module knows, or nothing: an unrecognised string must not end
  // up in a `data-` attribute or decide whether a warning is shown.
  const provider: ProviderName | undefined =
    value.provider === 'fake' || value.provider === 'anthropic' ? value.provider : undefined;
  return { suggested: value.suggested, why, ...(provider === undefined ? {} : { provider }) };
}

export interface RecallRequestInput {
  entryId: string;
  senseIndex?: number;
  answer: string;
}

export interface RecallRequestOptions {
  /** The caller's cancellation — an unmount, or the next card. */
  signal?: AbortSignal;
  /** Injected by tests; production uses the global. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The seam the component is written against, so a test needs no network. */
export type RecallRequest = (
  input: RecallRequestInput,
  options?: RecallRequestOptions,
) => Promise<RecallSuggestion | null>;

/**
 * Ask `/api/recall` what it makes of a typed answer.
 *
 * An empty answer never leaves the browser: there is nothing to grade, and a
 * provider asked to judge silence would answer "1", which is a wrong answer
 * rather than an unanswered one. The learner flipped the card without typing;
 * that is not a lapse, it is a decision.
 */
export const requestRecallGrade: RecallRequest = async (input, options = {}) => {
  const answer = input.answer.trim();
  if (!answer || !input.entryId) return null;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) return null;
  options.signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, options.timeoutMs ?? RECALL_CLIENT_TIMEOUT_MS);

  try {
    const response = await fetchImpl('/api/recall', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        entryId: input.entryId,
        ...(input.senseIndex === undefined ? {} : { senseIndex: input.senseIndex }),
        answer: answer.slice(0, RECALL_ANSWER_MAX_CHARS),
      }),
    });
    if (!response.ok) return null;
    return asRecallSuggestion(await response.json());
  } catch {
    // Every failure is the same failure here: no suggestion. The learner is
    // looking at a flipped card with four live buttons either way.
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
};

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * `idle` — nothing submitted yet, the box takes typing.
 * `grading` — submitted, the card has flipped, a suggestion may still land.
 * `settled` — submitted, and the wait is over (a suggestion, or none).
 */
export type RecallPhase = 'idle' | 'grading' | 'settled';

export interface RecallState {
  /**
   * The card this is about. It is in the state rather than beside it so that
   * "the queue moved on" needs no effect and no cleanup: a state belonging to
   * another card is simply not this box's state, which the caller reads as a
   * blank box in the same render it receives the new card.
   */
  cardId: string;
  phase: RecallPhase;
  /** What is in the box while idle; what was submitted afterwards. */
  answer: string;
  /**
   * The one request whose result may still land. Zero is "none outstanding",
   * so a blank submit — which asks nobody — can never be settled by anything.
   */
  requestId: number;
  suggestion: RecallSuggestion | null;
  /** A request was made and came back with nothing. Said quietly, once. */
  failed: boolean;
}

export function blankRecall(cardId: string): RecallState {
  return { cardId, phase: 'idle', answer: '', requestId: 0, suggestion: null, failed: false };
}

export type RecallAction =
  | { type: 'type'; cardId: string; answer: string }
  | { type: 'submit'; cardId: string; requestId: number }
  | { type: 'settled'; cardId: string; requestId: number; suggestion: RecallSuggestion | null };

/**
 * The whole machine. Note what it cannot express: there is no action that means
 * "grade the card" and no field a grade could be read out of. The most a
 * suggestion can do is sit in `suggestion` and ring a button.
 */
export function recallReducer(state: RecallState, action: RecallAction): RecallState {
  // An action about another card is an action about another question. Typing is
  // the one thing allowed to *start* one, because the box being typed into is
  // by definition the box on screen.
  if (action.cardId !== state.cardId) {
    if (action.type !== 'type') return state;
    return { ...blankRecall(action.cardId), answer: action.answer };
  }

  switch (action.type) {
    case 'type':
      // A question already asked cannot be edited into a different one.
      return state.phase === 'idle' ? { ...state, answer: action.answer } : state;

    case 'submit': {
      if (state.phase !== 'idle') return state;
      const answer = state.answer.trim();
      // A blank submit is a flip, not a question: it settles at once and asks
      // nobody. `failed` stays false — nothing was tried, so nothing failed.
      if (!answer) return { ...state, phase: 'settled', answer: '', requestId: 0 };
      return {
        ...state,
        phase: 'grading',
        answer,
        requestId: action.requestId,
        suggestion: null,
        failed: false,
      };
    }

    case 'settled': {
      // The guard the no-auto-submit rule rests on: only the request still
      // being waited for may change anything, and a card that has moved on
      // (handled above) or a blank submit (`requestId: 0`) matches nothing.
      if (state.phase !== 'grading') return state;
      if (action.requestId === 0 || action.requestId !== state.requestId) return state;
      return {
        ...state,
        phase: 'settled',
        suggestion: action.suggestion,
        failed: action.suggestion === null,
      };
    }

    default:
      return state;
  }
}
