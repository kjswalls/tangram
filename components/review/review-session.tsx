'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { GradeBar } from '@/components/review/grade-bar';
import { RecallInput } from '@/components/review/recall-input';
import { ReviewCard } from '@/components/review/review-card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { RecallSuggestion } from '@/lib/ai/recall';
import { DEFAULT_SETTINGS, type StoredRating } from '@/lib/db/schema';
import { emptyStateMessage, gradeOptions, isRevealKey, ratingFromKey } from '@/lib/srs/session';
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

  const [suggestion, setSuggestion] = useState<{ cardId: string; value: RecallSuggestion } | null>(
    null,
  );
  const onSuggestion = useCallback((cardId: string, value: RecallSuggestion | null) => {
    setSuggestion(value ? { cardId, value } : null);
  }, []);

  const card = queue[index];
  const script = settings?.script ?? DEFAULT_SETTINGS.script;
  // A phrase card has no dictionary entry to judge an answer against (its
  // meaning is the English on its back), so the box is offered on word cards.
  const freeRecall =
    (settings?.freeRecall ?? DEFAULT_SETTINGS.freeRecall ?? false) &&
    card !== undefined &&
    card.kind === 'word' &&
    card.entryId !== null;
  const suggested =
    card !== undefined && suggestion?.cardId === card.id ? suggestion.value.suggested : null;

  // The intervals are computed against the same instant the queue was built —
  // `store.now`, set by `load()` before `loaded` flips — so the four labels do
  // not drift while the card sits on screen, and render stays pure.
  const options = useMemo(
    () => (card ? gradeOptions(card.fsrs, now) : []),
    [card, now],
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
          {emptyStateMessage(nextDue, now, waiting)}
        </p>
        {drawError ? (
          <p className="mt-2 text-sm text-warning">No new words could be drawn: {drawError}</p>
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
      />

      {revealed ? (
        <GradeBar options={options} disabled={grading} suggested={suggested} onGrade={onGrade} />
      ) : (
        <Button data-testid="reveal" size="lg" className="w-full" onClick={reveal}>
          Show answer
        </Button>
      )}
    </div>
  );
}
