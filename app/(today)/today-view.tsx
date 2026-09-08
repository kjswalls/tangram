'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getRepository } from '@/lib/db/get-db';
import { isPhraseSnapshot, type CardRow } from '@/lib/db/schema';
import { loadDemo } from '@/lib/dev/seed';
import { loadToday, type TodaySummary } from '@/lib/lists/today';
import { countByDirection, isProduction } from '@/lib/srs/direction';

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
 * Today (PLAN.md §3.3). Opening this page is what *introduces* the day's new
 * words: `loadToday` draws them, creates their cards and charges the persisted
 * counter, so the number here and the cards `/review` offers cannot disagree.
 */
export function TodayView() {
  const [summary, setSummary] = useState<TodaySummary>();
  const [error, setError] = useState<string>();
  const [demo, setDemo] = useState(false);

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
        const next = await loadToday({ repo: getRepository() });
        if (!cancelled) setSummary(next);
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
  const fresh = summary?.newCount ?? 0;
  const ready = due + fresh > 0;
  // The two directions, counted apart (Phase 8). A learner who has turned
  // production on has signed up for a second card per word, and the one number
  // that used to stand for "cards" now hides which half is which. Shown only
  // once there is a production card to show: before that it is noise.
  const split = countByDirection(summary?.queue.cards ?? []);

  return (
    <div className="flex flex-col gap-4">
      <Card title="Queue" aside={summary ? <Badge tone="neutral">{summary.newPerDay}/day</Badge> : null}>
        {error ? (
          <p role="status" className="text-sm text-warning">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-stretch">
          <p className="flex min-w-20 flex-col pr-6">
            <span data-testid="today-due-count" className="text-3xl font-semibold tabular-nums">
              {summary ? due : '—'}
            </span>
            <span className="text-sm text-muted">due</span>
          </p>
          {/* A rule between them: "0" and "10" side by side read as one number. */}
          <p className="flex min-w-20 flex-col border-l border-border pl-6">
            <span data-testid="today-new-count" className="text-3xl font-semibold tabular-nums">
              {summary ? fresh : '—'}
            </span>
            <span className="text-sm text-muted">new</span>
          </p>
        </div>

        {split.production > 0 ? (
          <p data-testid="today-direction-split" className="mt-3 text-sm text-muted">
            <span data-testid="today-recognition-count" className="tabular-nums">
              {split.recognition}
            </span>{' '}
            hanzi → meaning ·{' '}
            <span data-testid="today-production-count" className="tabular-nums">
              {split.production}
            </span>{' '}
            meaning → hanzi
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link href="/review" data-testid="start-review">
            <Button disabled={!ready}>Start review</Button>
          </Link>
          {summary ? (
            <span className="text-sm text-muted">
              {summary.introducedToday} of {summary.newPerDay} new words introduced today
            </span>
          ) : null}
        </div>

        {summary && !ready ? (
          <p className="mt-3 text-sm text-muted">
            Nothing waiting. Look a word up, or raise the daily new count in{' '}
            <Link href="/settings" className="text-accent underline underline-offset-2">
              settings
            </Link>
            .
          </p>
        ) : null}

        {summary?.drawError ? (
          <p className="mt-3 text-sm text-warning">
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
                    {reverse ? <span className="text-sm text-muted">write </span> : null}
                    <span className="hanzi text-lg">{simp}</span>{' '}
                    {reverse ? null : <span className="text-sm text-muted">{pinyin}</span>}
                    <span className="block truncate text-sm text-muted">{gloss}</span>
                  </span>
                  {reverse ? (
                    <Badge tone="accent">reverse</Badge>
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
