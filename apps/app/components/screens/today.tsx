'use client';

import { useEffect, useState } from 'react';

import { useScreenNavigate } from '@/components/screens/navigate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getRepository } from '@/lib/db/get-db';
import { isPhraseSnapshot, type CardRow } from '@/lib/db/schema';
import { isDictUnavailable } from '@/lib/dict/unavailable';
import { loadDemo } from '@/lib/dev/seed';
import { loadToday, type TodaySummary } from '@/lib/lists/today';
import { todaySentence } from '@/lib/lists/today-sentence';
import { countByDirection, DIRECTION_LABELS, isProduction } from '@/lib/srs/direction';
import { DEFAULT_SECONDS_PER_REVIEW, medianSecondsPerReview } from '@/lib/srs/pace';

/** `?seed=demo` runs once per page load, not once per effect (StrictMode). */
let seeding: Promise<unknown> | undefined;

function front(card: CardRow): { simp: string; pinyin: string; gloss: string } {
  const snapshot = card.snapshot;
  if (isPhraseSnapshot(snapshot)) {
    return { simp: snapshot.simp, pinyin: snapshot.pinyinMarked, gloss: snapshot.en };
  }
  // Three senses, joined, exactly as the search rows show them: CC-CEDICT's
  // first gloss for a single-character spine word is often the wrong sense
  // ("被 — quilt", "时 — o'clock"), and one word of context fixes it.
  return {
    simp: snapshot.simp,
    pinyin: snapshot.pinyinMarked,
    gloss: snapshot.glosses.slice(0, 3).join('; '),
  };
}

/**
 * Today (PLAN.md §3.3), as a **region of the Look up tab** since C7.
 *
 * **It no longer introduces anything, and that is the point of the merge.**
 * Opening this page used to draw the day's new words, create their cards and
 * charge `settings.introduced[dayKey]` — so a learner who opened the app and
 * closed it had spent the day's ten. `wave-zero.md` §9 makes **Practice the
 * only place any of the three is reached**, so this passes `introduce: false`
 * and reports what the session *will* offer: the new cards that already exist
 * plus what today's cap allows and the spine can supply
 * (`TodaySummary.newToOffer`). The number
 * is the same number; what changed is that reading it costs nothing.
 *
 * **C8 turned the two tiles into one sentence, and they are gone** — not folded
 * into it as spans. `today-due-count`, `today-new-count` and
 * `today-direction-split` no longer exist; the wording lives in
 * `lib/lists/today-sentence.ts` so it can be tested without a browser, and the
 * specs that read the tiles read `today-sentence`. (This header said the tiles
 * survived for one commit after they did not — C7 wrote it and C8 did the work
 * a few lines below without coming back up here.)
 */
export function TodayView() {
  const go = useScreenNavigate();
  const [summary, setSummary] = useState<TodaySummary>();
  const [error, setError] = useState<string>();
  const [demo, setDemo] = useState(false);
  /**
   * The learner's own median seconds per item, once there is one
   * (`lib/srs/pace.ts`). Undefined means "not enough of their history yet" and
   * the sentence falls back to the named placeholder — C8 is explicit that the
   * duration must be derived rather than invented.
   */
  const [pace, setPace] = useState<number>();

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('seed') === 'demo') {
        setDemo(true);
        seeding ??= loadDemo();
        try {
          await seeding;
        } finally {
          seeding = undefined;
        }
        // Drop the parameter and start over on the seeded database, so nothing
        // downstream has to know a seed just happened.
        window.location.replace('/');
        return;
      }
      try {
        // See the header: reporting, not introducing.
        const repo = getRepository();
        const next = await loadToday({ repo, introduce: false });
        if (!cancelled) setSummary(next);
        // After the summary, never before it: the sentence's counts are what
        // the screen is for, and the review log is the slower read of the two.
        const reviews = await repo.allReviewsChronological().catch(() => []);
        if (!cancelled) setPace(medianSecondsPerReview(reviews));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  if (demo) {
    return (
      <Card title="Demo">
        <p data-testid="today-seeding" className="text-sm text-muted">
          Loading the demo…
        </p>
      </Card>
    );
  }

  const due = summary?.dueCount ?? 0;
  // What Practice will offer, not what has already been created: with the
  // introduction moved into the session, `newCount` alone reads 0 on a fresh
  // database while the cap is holding ten words for the learner.
  const fresh = summary?.newToOffer ?? 0;
  const ready = due + fresh > 0;
  /**
   * **Today is a sentence** (docs/plans/core.md C8; product-decisions §2).
   *
   * The two tiles were the most prominent thing on the screen and are not the
   * most important thing on it. The counts are the same counts — the split by
   * direction is the one that was already here — and `lib/lists/today-sentence.ts`
   * is where the wording lives so it can be tested without a browser.
   *
   * `write` is the *due* production cards only. New words are counted once, as
   * new: a word the learner has never met is not yet a word they are being
   * asked to write.
   */
  const dueSplit = countByDirection(summary?.due ?? []);
  const newSplit = countByDirection(summary?.newCards ?? []);
  const counts = {
    practice: dueSplit.recognition,
    // Every card the learner will be asked to *write*, new or waiting: a
    // production card is a production card whether or not it has been met
    // before, and Phase 8's reason for counting the directions apart is that
    // one number for both stopped meaning anything.
    write: dueSplit.production + newSplit.production,
    // …so the new-word clause is the new words that are *not* already counted
    // as writing. `newToOffer` is what exists plus what today's cap still
    // allows, and the cap only ever draws recognition cards.
    fresh: Math.max(0, fresh - newSplit.production),
  };
  const sentence = summary ? todaySentence(counts, pace ?? DEFAULT_SECONDS_PER_REVIEW) : '';

  return (
    <div className="flex flex-col gap-4">
      {/* "Queue" and "10/day" are the scheduler's words on the screen C8 made
          into a sentence; "introduced" below is `introduceCards`'s verb. All
          three were inside the directories C8's jargon gate covers and all
          three survived the first pass. */}
      <Card
        title="Today"
        aside={
          summary ? <Badge tone="neutral">{summary.newPerDay} new a day</Badge> : null
        }
      >
        {/*
          **Not the missing dictionary** (docs/plans/web.md W6, part 2). Today is
          a region of the Look up tab, and that tab already renders `<DictGate>`
          above this card — the "Get the dictionary" card, which says the same
          thing in better words and carries the button. A red line underneath it
          repeating the raw `Error.message` was the app stating one fact twice,
          in two registers, the second of them a lowercase fragment.

          Anything that is NOT the dictionary still has to be said, and is.
        */}
        {error && !isDictUnavailable(error) ? (
          <p role="status" data-testid="today-error" className="text-sm text-warning">
            {error}
          </p>
        ) : null}

        {/*
          One sentence, and **the two tiles are gone** — not hidden inside it as
          spans. `today-due-count`, `today-new-count` and `today-direction-split`
          no longer exist; the specs that read them read `today-sentence`.
        */}
        <p data-testid="today-sentence" className="text-base">
          {summary ? sentence : 'Counting what is waiting…'}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            data-testid="start-review"
            disabled={!ready}
            onClick={() => go({ tab: 'practice' })}
          >
            Start practice
          </Button>
          {summary ? (
            <span className="text-sm text-muted">
              {summary.introducedToday} of {summary.newPerDay} new words started today
            </span>
          ) : null}
        </div>

        {/*
          The way out, when there is nothing to do. The sentence above already
          says "Nothing waiting" — this used to repeat it, which is the tile
          grid's habit of stating the same fact twice in two registers. Only
          the part the sentence cannot carry survives: a place to go.
        */}
        {summary && !ready ? (
          <p className="mt-3 text-sm text-muted">
            You can also raise the daily new count in{' '}
            <button
              type="button"
              className="text-accent underline underline-offset-2"
              onClick={() => go({ tab: 'library' })}
            >
              Library
            </button>
            .
          </p>
        ) : null}

        {/* Same rule as `error` above: the gate on this tab owns the missing
            dictionary, and this line owns everything else that can stop a draw. */}
        {summary?.drawError && !isDictUnavailable(summary.drawError) ? (
          <p data-testid="today-draw-error" className="mt-3 text-sm text-warning">
            No new words could be drawn: {summary.drawError}
          </p>
        ) : null}
      </Card>

      {summary && summary.newCards.length > 0 ? (
        <Card title="Today’s new words">
          <ul data-testid="today-new-list" className="flex flex-col divide-y divide-border">
            {summary.newCards.map((card) => {
              const { simp, pinyin, gloss } = front(card);
              // A word and its reverse are two rows here, and they used to be
              // two *identical* rows — same hanzi, same pinyin, same gloss, same
              // badge — which reads as the app having added the word twice. They
              // are two different questions, so they say so: the reverse leads
              // with what it asks of you and drops the reading, which is half of
              // its own answer.
              const reverse = isProduction(card);
              return (
                <li
                  key={card.id}
                  data-testid="today-new-word"
                  data-entry-id={card.entryId ?? ''}
                  data-direction={reverse ? 'production' : 'recognition'}
                  className="flex items-baseline justify-between gap-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="hanzi text-lg">{simp}</span>{' '}
                    {reverse ? null : <span className="text-sm text-muted">{pinyin}</span>}
                    <span className="block truncate text-sm text-muted">{gloss}</span>
                  </span>
                  {reverse ? (
                    // The direction, in C8's words — "Write", not "reverse",
                    // which described the *operation that made the card* rather
                    // than what it asks of the learner. Named once, in
                    // `lib/srs/direction.ts`.
                    <Badge tone="accent">{DIRECTION_LABELS.production}</Badge>
                  ) : card.context ? (
                    <Badge tone={card.context.source === 'list' ? 'neutral' : 'accent'}>
                      {card.context.source}
                    </Badge>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
