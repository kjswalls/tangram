'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AddReverse } from '@/components/review/add-reverse';
import { ExampleSentences } from '@/components/review/example-sentences';
import { GradeBar } from '@/components/review/grade-bar';
import { RecallInput } from '@/components/review/recall-input';
import { ProductionCard } from '@/components/review/production-card';
import { ReviewCard } from '@/components/review/review-card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { RecallSuggestion } from '@/lib/ai/recall';
import { DEFAULT_SETTINGS, type StoredRating } from '@/lib/db/schema';
import { isProduction, productionRecallRequest } from '@/lib/srs/direction';
import {
  emptyStateMessage,
  gradeOptions,
  isRevealKey,
  MAX_SESSION_REPEATS,
  ratingFromKey,
  sessionRefreshDelay,
} from '@/lib/srs/session';
import { useReviewStore } from '@/lib/stores/review';

/**
 * The review session (PLAN.md §4, P2).
 *
 * Space or Enter flips the card; 1–4 grade it; every other key is ignored. The
 * queue is re-read from the database after each grade (see the store), so what
 * is offered next always matches what was just written.
 *
 * When `settings.freeRecall` is on, the card front also carries the recall box
 * (Phase 6 item 2). This component is where the two halves of that feature meet
 * and it is deliberately the *only* place they do: the box reports a suggestion
 * for a card id, this holds it, and the grade bar rings the matching button.
 * The suggestion is filed against the card it was asked about, so one that
 * lands after the queue has moved on is simply never shown — and either way
 * nothing here turns a suggestion into a grade. `grade()` is reached from a
 * key press and a button click, exactly as it was before the feature existed.
 */
export function ReviewSession() {
  const queue = useReviewStore((state) => state.queue);
  const index = useReviewStore((state) => state.index);
  const revealed = useReviewStore((state) => state.revealed);
  const peeked = useReviewStore((state) => state.peeked);
  const loaded = useReviewStore((state) => state.loaded);
  const graded = useReviewStore((state) => state.graded);
  const grading = useReviewStore((state) => state.grading);
  const now = useReviewStore((state) => state.now);
  const nextDue = useReviewStore((state) => state.nextDue);
  const returning = useReviewStore((state) => state.returning);
  const deferred = useReviewStore((state) => state.deferred);
  const attempts = useReviewStore((state) => state.attempts);
  const waiting = useReviewStore((state) => state.waiting);
  const drawError = useReviewStore((state) => state.drawError);
  const settings = useReviewStore((state) => state.settings);
  const error = useReviewStore((state) => state.error);
  const load = useReviewStore((state) => state.load);
  const reveal = useReviewStore((state) => state.reveal);
  const peek = useReviewStore((state) => state.peek);
  const grade = useReviewStore((state) => state.grade);
  const reset = useReviewStore((state) => state.reset);

  useEffect(() => {
    void load();
    // Leaving the route ends the session: the counter is per-session, and the
    // next visit must re-read the queue rather than resume a stale one.
    return () => reset();
  }, [load, reset]);

  /**
   * Come back for a card that matures during the session.
   *
   * With `shortTermSteps` on (the default since Phase 8) a failed card is due
   * again in a minute or ten, so the queue emptying no longer means the session
   * is over — and until this existed the empty state simply stood there until
   * the learner reloaded. The timer only runs while nothing is on screen (a
   * re-read under a card would swap the card out mid-answer) and only for a
   * card inside the short-step horizon; beyond that the session really is over
   * and the empty state says when to come back.
   */
  const empty = queue[index] === undefined;
  useEffect(() => {
    if (!loaded || !empty) return;
    const delay = sessionRefreshDelay(nextDue, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer);
  }, [loaded, empty, nextDue, load]);
  /** Whether that timer is running — the empty state says so when it is. */
  const armed = empty && sessionRefreshDelay(nextDue, now) !== null;

  const [suggestion, setSuggestion] = useState<{ cardId: string; value: RecallSuggestion } | null>(
    null,
  );
  const onSuggestion = useCallback((cardId: string, value: RecallSuggestion | null) => {
    setSuggestion(value ? { cardId, value } : null);
  }, []);

  const card = queue[index];
  const script = settings?.script ?? DEFAULT_SETTINGS.script;
  // `undefined` is "not decided" on a settings row written before the toggle
  // existed, never "off" (HANDOFF-prep, §6).
  const examplesOnBack = settings?.examplesOnBack ?? DEFAULT_SETTINGS.examplesOnBack ?? true;
  // A phrase card has no dictionary entry to judge an answer against (its
  // meaning is the English on its back), so the box is offered on word cards.
  const judgeable = card !== undefined && card.kind === 'word' && card.entryId !== null;
  const production = card !== undefined && isProduction(card);
  const freeRecall =
    (settings?.freeRecall ?? DEFAULT_SETTINGS.freeRecall ?? false) && judgeable && !production;
  /**
   * The production card's box is the card. Typing the hanzi is the exercise, so
   * it is not gated on `settings.freeRecall` — that toggle is about offering to
   * type a *meaning* the recognition card would otherwise only ask you to think
   * of. What it is handed is a grader that settles an exact answer in the
   * browser and only asks the provider about a near miss.
   */
  const productionRequest = useMemo(
    () => (production && card ? productionRecallRequest(card, script) : undefined),
    [production, card, script],
  );
  const suggested =
    card !== undefined && suggestion?.cardId === card.id ? suggestion.value.suggested : null;

  // The intervals are computed against the same instant the queue was built —
  // `store.now`, set by `load()` before `loaded` flips — so the four labels do
  // not drift while the card sits on screen, and render stays pure.
  //
  // `settings` goes in because the parameters are part of the answer (Phase 8):
  // retention, the short-term learning steps and any fitted weights all change
  // what a button would schedule, and a label from a different scheduler than
  // the one that will run is a promise the app does not keep.
  const options = useMemo(
    () => (card ? gradeOptions(card.fsrs, now, settings) : []),
    [card, now, settings],
  );

  const onGrade = useCallback(
    (rating: StoredRating) => {
      void grade(rating);
    },
    [grade],
  );

  useEffect(() => {
    if (!card) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      if (!revealed) {
        if (!isRevealKey(event.key)) return;
        event.preventDefault();
        reveal();
        return;
      }

      const rating = ratingFromKey(event.key);
      if (rating === null) return;
      event.preventDefault();
      if (grading) return;
      void grade(rating);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [card, revealed, grading, reveal, grade]);

  if (!loaded) {
    return (
      <Card>
        <p data-testid="review-loading" className="text-sm text-muted">
          Loading your queue…
        </p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Session">
        <p data-testid="review-error" className="text-sm text-warning">
          {error}
        </p>
      </Card>
    );
  }

  if (!card) {
    return (
      <Card
        title="Session"
        aside={graded > 0 ? <span className="text-sm text-muted">{graded} graded</span> : null}
      >
        <p data-testid="review-empty" className="text-base">
          {emptyStateMessage({ next: nextDue, now, waiting, returning, deferred: deferred.length })}
        </p>
        {drawError ? (
          <p className="mt-2 text-sm text-warning">No new words could be drawn: {drawError}</p>
        ) : null}
        {/* The timer above is armed, so the cards come back here on their own —
            and nothing on screen used to say so. Both links below unmount the
            session (leaving the route calls `reset()`), so a learner who took
            one at "2 cards come back in 1 minute" walked away from a page that
            was about to refill itself. Said only when the timer is actually
            armed; when the next card is hours away the links are the answer. */}
        {armed ? (
          <p data-testid="review-empty-stay" className="mt-2 text-sm text-muted">
            Stay on this page — they come back on their own, with nothing to press.
          </p>
        ) : null}
        {/* Never a dead end: the one place that says what there is to do today. */}
        <p className="mt-3 text-sm text-muted">
          <Link href="/" className="text-accent underline underline-offset-2">
            Back to Today
          </Link>{' '}
          for what is left, or{' '}
          <Link href="/lookup" className="text-accent underline underline-offset-2">
            look a word up
          </Link>
          .
        </p>
      </Card>
    );
  }

  const remaining = queue.length - index;

  return (
    <div data-testid="review-session" className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <p data-testid="review-progress" className="text-sm text-muted">
          Card {graded + 1} of {graded + remaining}
        </p>
        <p className="text-xs text-muted">
          {revealed ? '1–4 to grade' : 'Space to flip'}
        </p>
      </div>

      {/* The session's own cap, said out loud before it bites. A card can come
          back inside the session now, so one you keep missing would otherwise
          come round forever; after MAX_SESSION_REPEATS it is set aside. */}
      {attempts >= MAX_SESSION_REPEATS - 2 ? (
        <p data-testid="review-repeat-notice" className="text-xs text-warning">
          Seen {attempts} {attempts === 1 ? 'time' : 'times'} this session
          {attempts >= MAX_SESSION_REPEATS - 1
            ? ' — one more and it is set aside until next time.'
            : `. After ${MAX_SESSION_REPEATS} it is set aside until next time.`}
        </p>
      ) : null}

      {production ? (
        <ProductionCard
          card={card}
          script={script}
          revealed={revealed}
          onReveal={reveal}
          recall={
            <RecallInput
              key={card.id}
              card={card}
              revealed={revealed}
              onReveal={reveal}
              onSuggestion={onSuggestion}
              request={productionRequest}
              label="Write it in hanzi"
              placeholder="the characters"
            />
          }
          examples={
            examplesOnBack ? (
              <ExampleSentences
                key={card.id}
                entryId={card.entryId}
                script={script}
                {...(card.senseIndex === undefined ? {} : { senseIndex: card.senseIndex })}
              />
            ) : null
          }
        />
      ) : (
        <ReviewCard
          card={card}
          script={script}
          revealed={revealed}
          peeked={peeked}
          onPeek={peek}
          onReveal={reveal}
          recall={
            freeRecall ? (
              // Keyed on the card: a new card is a new question, and the key is
              // what abandons the previous one's request rather than letting its
              // answer land under a different word.
              <RecallInput
                key={card.id}
                card={card}
                revealed={revealed}
                onReveal={reveal}
                onSuggestion={onSuggestion}
              />
            ) : null
          }
          actions={
            // Offered only where a reverse can exist and the learner has said
            // they want the direction at all. Pressing it is what makes the card;
            // the setting only opens the door (lib/srs/direction.ts).
            settings?.productionDirection && judgeable ? <AddReverse key={card.id} card={card} /> : null
          }
          // The slot only mounts once the back is on screen, which is what keeps
          // the flip instant: the sentences are fetched after the reveal, never
          // before it. Off means gone, not hidden.
          examples={
            examplesOnBack ? (
              <ExampleSentences
                key={card.id}
                entryId={card.entryId}
                // The same preference the front is drawn with: one card, one script.
                script={script}
                {...(card.senseIndex === undefined ? {} : { senseIndex: card.senseIndex })}
              />
            ) : null
          }
        />
      )}

      {revealed ? (
        // Sticky to the bottom of the viewport on a phone. The back of a card
        // can be taller than the screen — glosses, the i+1 block, the context
        // box — and the four buttons are the only way to move on when there is
        // no keyboard to press 1–4 on. Above `sm` it sits where it always did.
        <div
          data-testid="grade-dock"
          className="sticky bottom-0 z-10 bg-background pt-2 pb-2 sm:static sm:bg-transparent sm:p-0"
        >
          <GradeBar options={options} disabled={grading} suggested={suggested} onGrade={onGrade} />
        </div>
      ) : (
        <Button data-testid="reveal" size="lg" className="w-full" onClick={reveal}>
          Show answer
        </Button>
      )}
    </div>
  );
}
