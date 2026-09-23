'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useScreenNavigate } from '@/components/screens/navigate';

import { AddReverse } from '@/components/review/add-reverse';
import { ExampleSentences } from '@/components/review/example-sentences';
import { GradeBar } from '@/components/review/grade-bar';
import { RecallInput } from '@/components/review/recall-input';
import { ProductionCard } from '@/components/review/production-card';
import { ReviewCard } from '@/components/review/review-card';
import { DictNotice } from '@/components/dict/dict-gate';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { RecallSuggestion } from '@tangram/ai/recall';
import { DEFAULT_SETTINGS, type StoredRating } from '@/lib/db/schema';
import { isDictUnavailable } from '@/lib/dict/unavailable';
import { isProduction, productionRecallRequest } from '@/lib/srs/direction';
import {
  emptyStateMessage,
  gradeOptions,
  MAX_SESSION_REPEATS,
  sessionRefreshDelay,
} from '@/lib/srs/session';
import { TangramProgress } from '@/components/practice/tangram-progress';
import { useReviewStore } from '@/lib/stores/review';
import { API_CONFIGURED } from '@/src/access/client';
import { useShortcuts } from '@/src/keys/use-shortcuts';

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
export interface ReviewSessionProps {
  /**
   * Whether this build has an API (`API_CONFIGURED`). A prop only so the unit
   * tests can draw the no-API session without a second build.
   */
  apiConfigured?: boolean;
}

export function ReviewSession({ apiConfigured = API_CONFIGURED }: ReviewSessionProps = {}) {
  const go = useScreenNavigate();
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
  //
  // **Neither card feature exists on a build with no API** (`API_CONFIGURED`).
  // Library does not offer their toggles there, so a stored `true` — the
  // default for sentences, or a `freeRecall` restored from a backup made on a
  // build that had one — would otherwise be a setting the learner can see the
  // effect of on every card and has no way to turn off.
  const examplesOnBack =
    apiConfigured && (settings?.examplesOnBack ?? DEFAULT_SETTINGS.examplesOnBack ?? true);
  // A phrase card has no dictionary entry to judge an answer against (its
  // meaning is the English on its back), so the box is offered on word cards.
  const judgeable = card !== undefined && card.kind === 'word' && card.entryId !== null;
  const production = card !== undefined && isProduction(card);
  const freeRecall =
    apiConfigured &&
    (settings?.freeRecall ?? DEFAULT_SETTINGS.freeRecall ?? false) &&
    judgeable &&
    !production;
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

  /**
   * The session's six bindings (docs/plans/web.md W8).
   *
   * They used to be a hand-written `window` listener right here, with the
   * text-input guard written out as an `if` — which is the shape W8 replaces,
   * because the rule then holds only for as long as everybody remembers to
   * write it. The bindings are rows in `src/keys/registry.ts` under the
   * `review` scope now, and the scope is what refuses to fire them while the
   * free-recall box has focus. The behaviour is unchanged and deliberately so:
   * a handler that is `undefined` is a key nothing takes, which is exactly what
   * the old early-returns produced.
   *
   * `grading` is checked *inside* the handler rather than by withholding it,
   * because the old listener called `preventDefault()` before that check: a
   * second Space while a grade is in flight must be swallowed, not passed to
   * the page to scroll with.
   */
  const gradeWith = (rating: StoredRating) => () => {
    if (grading) return;
    void grade(rating);
  };
  useShortcuts('review', {
    'review.reveal': card && !revealed ? () => reveal() : undefined,
    'review.grade.1': card && revealed ? gradeWith(1) : undefined,
    'review.grade.2': card && revealed ? gradeWith(2) : undefined,
    'review.grade.3': card && revealed ? gradeWith(3) : undefined,
    'review.grade.4': card && revealed ? gradeWith(4) : undefined,
  });

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
    /*
      **One error surface** (docs/plans/web.md W6, part 2). "No dictionary on
      this device" is not a session failure and must not be dressed as one: it
      gets the dictionary's own card — the one naming the size, with the button
      — which is the same card Look up and Library show. Practice itself still
      works without it, so the session card stays beside it.
    */
    if (isDictUnavailable(error)) {
      return (
        <div className="flex flex-col gap-4">
          <DictNotice />
          <Card title="Session">
            <p data-testid="review-empty" className="text-base">
              {emptyStateMessage({ next: nextDue, now, waiting, returning, deferred: deferred.length })}
            </p>
          </Card>
        </div>
      );
    }
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
      <div className="flex flex-col gap-4">
      {/*
        **The one error surface** (docs/plans/web.md W6, part 2).

        This is the branch a learner on a fresh origin actually lands in: the
        day's new words could not be drawn because there is no dictionary, so
        the empty state below says something about words that are "waiting", and
        underneath it the raw `Error.message` used to appear as a second red
        sentence. One fact, said twice, in two registers.

        The card is the dictionary's own — the same one Look up and Library show
        — so the three tabs now say this one way, and a learner who is told the
        dictionary is missing is given the button that fetches it.
      */}
      {isDictUnavailable(drawError) ? <DictNotice /> : null}
      <Card
        title="Session"
        aside={graded > 0 ? <span className="text-sm text-muted">{graded} done</span> : null}
      >
        {/*
          **The finished square** (docs/plans/core.md C8). The pieces fill as the
          session runs and the last grade is what completes them — so if the
          square only existed while a card was on screen, the one state it is
          built for is the one nobody would ever see. It is here when a session
          just ended (`graded > 0`) and absent on an idle Practice tab, which is
          what "never appears outside a running session" means.

          **The denominator is not `graded`.** It was, for one commit, and that
          made the square 7/7 and the label "All done" every time the queue was
          *momentarily* empty: press "Forgot it" on the only card and the page
          says "1 word comes back in 1 minute. Stay on this page" under a
          finished square. The work still owed is the cards coming back inside
          the session's horizon plus the ones it set aside, so they are in the
          total. The square completes only when both are zero — which is what
          "at the end the square is complete" was always supposed to mean.
        */}
        {graded > 0 ? (
          <TangramProgress
            done={graded}
            total={graded + returning + deferred.length}
            className="mb-3"
          />
        ) : null}
        <p data-testid="review-empty" className="text-base">
          {emptyStateMessage({ next: nextDue, now, waiting, returning, deferred: deferred.length })}
        </p>
        {/* Same rule: the dictionary's absence is the card below, not a red
            line here. Everything else that can stop a draw still says so. */}
        {drawError && !isDictUnavailable(drawError) ? (
          <p data-testid="review-draw-error" className="mt-2 text-sm text-warning">
            No new words could be drawn: {drawError}
          </p>
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
        {/*
          Never a dead end. Since core.md C7 both halves of this sentence are
          the same destination — Today is a region of the Look up tab — so it is
          one way out rather than two, and it goes through `useScreenNavigate`
          because a screen may not know a path.
        */}
        <p className="mt-3 text-sm text-muted">
          <button
            type="button"
            data-testid="practice-empty-lookup"
            className="text-accent underline underline-offset-2"
            onClick={() => go({ tab: 'lookup' })}
          >
            Look a word up
          </button>{' '}
          — what you add is in the next session.
        </p>
      </Card>
      </div>
    );
  }

  const remaining = queue.length - index;

  return (
    <div data-testid="review-session" className="space-y-4">
      {/*
        **The seven pieces** (docs/plans/core.md C8; `wave-zero.md` §7).

        C8's Files list mounts them in `components/screens/practice.tsx`, but
        the two numbers they need — how many items this session has and how many
        are done — exist only here, and a screen reaching into the review store
        to re-derive them would be a second source of truth for the session's
        progress. They are mounted here instead, inside the running-session
        branch, which is also what satisfies "never appears outside a running
        session": the empty state above returns before this point. Recorded in
        HANDOFF.md.

        The denominator is `graded + remaining`, the same one the old
        "Card 1 of 2" line used, so a card that comes back on a short step
        lengthens the session honestly rather than making the square overflow.
      */}
      <div data-testid="review-progress" className="flex items-center justify-between gap-3">
        <TangramProgress done={graded} total={graded + remaining} />
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
          /*
            **Above the tab bar, not under it.** `sticky bottom-0` pins to the
            bottom of the *viewport*, which on a phone is where the shell's
            fixed tab bar is — so the bottom row of grade buttons was painted
            behind the tab links and a tap on "Got it" navigated to Look up.
            `--tab-bar-height` is the bar's own height (zero in the wide
            arrangement), declared once in `tokens.css`.
          */
          className="sticky bottom-[var(--tab-bar-height,0px)] z-10 bg-background pt-2 pb-2 sm:static sm:bg-transparent sm:p-0"
        >
          <GradeBar options={options} disabled={grading} suggested={suggested} onGrade={onGrade} />
        </div>
      ) : (
        <Button data-testid="reveal" size="lg" className="w-full" onClick={reveal}>
          Show the answer
        </Button>
      )}
    </div>
  );
}
