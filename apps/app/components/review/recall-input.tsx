'use client';

/**
 * The free-recall box (PLAN.md §4, Phase 6 item 2): type what you think the
 * word means, and the app suggests a grade you can always override.
 *
 * It renders into the review card's `recall` slot — the front, under the hanzi
 * — because recall is what the learner does *before* they see the answer. The
 * card owns the placement and the fact that a keystroke in here must not flip
 * it; everything else about the feature lives here and in `lib/ai/recall.ts`.
 *
 * Three rules, in the order they matter:
 *
 *  1. **Nothing is ever submitted for the learner.** This component has no way
 *     to grade a card: it takes no grading callback and reaches no store. The
 *     suggestion travels *up* through `onSuggestion` to highlight one of the
 *     four buttons, and the grade is still written by a key press or a click.
 *     A suggestion that arrives late lands on a request id nobody is waiting
 *     for and changes nothing (`recallReducer`).
 *  2. **The flip never waits on the network.** `onReveal()` is called in the
 *     same turn as the submit, before the request is even started. A provider
 *     that is slow, broken, or absent costs the learner nothing but a
 *     suggestion.
 *  3. **A failure is quiet.** No error banner, no retry, one muted line saying
 *     there is no suggestion. The learner was going to grade this themselves.
 *
 * One piece of plumbing worth naming: the submit blurs whatever had focus. The
 * card wrapper stops key events from escaping the slot (so typing "3" into the
 * box is not a grade), which means that with focus still inside the box after
 * the flip, pressing 3 to grade would do nothing at all.
 */

import { useCallback, useEffect, useId, useReducer, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  blankRecall,
  recallReducer,
  requestRecallGrade,
  type RecallRequest,
  type RecallSuggestion,
} from '@/lib/ai/recall';
import type { CardRow } from '@/lib/db/schema';
import { RATING_LABELS } from '@/lib/srs/card';

const OFFLINE_NOTE = 'Offline grader — set ANTHROPIC_API_KEY for a real reading of your answer.';

export interface RecallInputProps {
  card: CardRow;
  revealed: boolean;
  /** Flip the card. Called on submit, synchronously, before anything is asked. */
  onReveal: () => void;
  /**
   * The suggestion, for the caller that owns the grade bar. It is advice about
   * a card id, never an instruction: the caller shows it against the card it
   * names and discards it otherwise.
   */
  onSuggestion?: (cardId: string, suggestion: RecallSuggestion | null) => void;
  /** The network seam, injected by tests — and by the production direction,
   *  which grades an exact answer locally and never asks anyone
   *  (`productionRecallRequest`, lib/srs/direction.ts). */
  request?: RecallRequest;
  /**
   * What the box is asking for. It defaults to the meaning, which is what the
   * recognition card wants; the production card asks for the characters
   * instead. Only the two strings differ — the state machine, the "nothing is
   * ever submitted for the learner" rule and the late-suggestion guard are the
   * same box either way, which is the point of passing copy rather than
   * writing a second one.
   */
  label?: string;
  placeholder?: string;
}

export function RecallInput({
  card,
  revealed,
  onReveal,
  onSuggestion,
  request = requestRecallGrade,
  label = 'What does it mean?',
  placeholder = 'in your own words',
}: RecallInputProps) {
  const [stored, dispatch] = useReducer(recallReducer, card.id, blankRecall);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const fieldId = useId();

  // A new card is a new question, and that is a *derivation*, not an effect:
  // state belonging to another card is not this box's state. The caller keys
  // this component on the card id, so in practice a fresh card is a fresh
  // instance — this is what keeps the component right for a caller that does
  // not, without a reset effect that would fire a cascading render on mount.
  const state = stored.cardId === card.id ? stored : blankRecall(card.id);

  // Whether this box is still the one on screen. A suggestion for a card the
  // learner has already graded must reach nobody: reporting it upward would
  // replace the suggestion belonging to the card that *is* on screen (or blank
  // it, if the abandoned request came back empty), which is the one way a late
  // answer could still change what the grade bar says. The same cleanup drops
  // the request itself, so nothing is left waiting on a card nobody is looking
  // at.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const submit = useCallback(() => {
    // Once the back is up there is nothing left to recall, so there is nothing
    // to grade either — see `closed` below.
    if (state.phase !== 'idle' || revealed) return;
    const typed = state.answer.trim();

    // Hand the keyboard back to the session: 1–4 are grades, and this slot
    // swallows the keys that reach it. Whatever the submit came from — the box
    // on Enter, the button on a click — is what has focus, so blurring the
    // active element covers both without a ref into either.
    const focused = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);
    focused?.blur?.();

    const requestId = typed ? requestIdRef.current + 1 : 0;
    if (typed) requestIdRef.current = requestId;
    dispatch({ type: 'submit', cardId: card.id, requestId });

    // The flip, first and unconditionally.
    if (!revealed) onReveal();
    if (!typed) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const settle = (suggestion: RecallSuggestion | null): void => {
      dispatch({ type: 'settled', cardId: card.id, requestId, suggestion });
      if (mountedRef.current && requestIdRef.current === requestId) {
        onSuggestion?.(card.id, suggestion);
      }
    };
    void request(
      {
        entryId: card.entryId ?? '',
        ...(card.senseIndex === undefined ? {} : { senseIndex: card.senseIndex }),
        answer: typed,
      },
      { signal: controller.signal },
    ).then(settle, () => settle(null));
  }, [
    card.entryId,
    card.id,
    card.senseIndex,
    onReveal,
    onSuggestion,
    request,
    revealed,
    state.answer,
    state.phase,
  ]);

  const answered = state.phase !== 'idle';
  /**
   * The box closes when the answer does — either because it was submitted, or
   * because the learner flipped the card another way. Typing a "recall" with
   * the glosses on screen is not recall, and a suggested 4 read off the back of
   * the card is the one grade this feature must never help anyone give
   * themselves.
   */
  const closed = answered || revealed;
  const suggestion = state.suggestion;

  return (
    <div data-testid="recall" data-phase={state.phase} className="space-y-2">
      <label htmlFor={fieldId} className="block text-xs tracking-wide text-muted uppercase">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={fieldId}
          data-testid="recall-answer"
          /*
           * The box takes the keyboard as soon as the card is on screen — on
           * mount, which is once per card, because the caller keys this
           * component on `card.id`.
           *
           * Without it the answer has to be reached with the mouse or eight
           * tabs, and — worse — the first space in a natural answer ("close
           * by") is a *reveal* key to the session's window listener: the card
           * flips mid-word, the box disables itself, and the recall is over
           * before it was typed. Focus is what makes a space a space. The
           * session ignores keys aimed at an `INPUT` and the card's wrapper
           * stops the rest from escaping the slot, so 1–4 still grade once
           * `submit()` has blurred the box.
           */
          autoFocus={!revealed}
          autoComplete="off"
          placeholder={placeholder}
          value={state.answer}
          disabled={closed}
          onChange={(event) =>
            dispatch({ type: 'type', cardId: card.id, answer: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submit();
          }}
        />
        {closed ? null : (
          <Button data-testid="recall-submit" variant="secondary" onClick={submit}>
            Check
          </Button>
        )}
      </div>

      {revealed && !answered ? (
        <p data-testid="recall-missed" className="text-xs text-muted">
          The answer is up — grade it yourself.
        </p>
      ) : null}

      {state.phase === 'grading' ? (
        <p data-testid="recall-thinking" className="text-xs text-muted">
          Reading your answer…
        </p>
      ) : null}

      {suggestion ? (
        <p
          data-testid="recall-suggestion"
          data-suggested={suggestion.suggested}
          className="text-sm"
        >
          <span className="font-medium text-accent">
            Suggested: {suggestion.suggested} · {RATING_LABELS[suggestion.suggested]}
          </span>
          {suggestion.why ? (
            <>
              {' — '}
              <span data-testid="recall-why" className="text-muted">
                {suggestion.why}
              </span>
            </>
          ) : null}
          <span className="mt-1 block text-xs text-muted">
            A suggestion only — you grade the card.
          </span>
          {suggestion.provider === 'fake' ? (
            // The same disclosure the ask panel and the i+1 block carry
            // (PLAN.md §3.4). A grade recommendation is the most consequential
            // thing this app suggests, and offline it is a word counter: that
            // has to be visible as a property of the UI, not as prose the
            // provider happened to write.
            <span data-testid="recall-offline" className="mt-1 block text-xs text-warning">
              {OFFLINE_NOTE}
            </span>
          ) : null}
        </p>
      ) : null}

      {state.failed ? (
        <p data-testid="recall-no-suggestion" className="text-xs text-muted">
          No suggestion this time — grade it yourself.
        </p>
      ) : null}
    </div>
  );
}
