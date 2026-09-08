'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { getRepository } from '@/lib/db/get-db';
import type { FsrsCardState, ReviewRow, SettingsRow } from '@/lib/db/schema';
import {
  buildTrainingSet,
  forgetPrevious,
  MIN_REVIEWS_FOR_FIT,
  optimizeWeights,
  readPrevious,
  rememberPrevious,
  type OptimizeResult,
  type PreviousWeights,
} from '@/lib/fsrs-optimize';
import { describeParameters } from '@/lib/srs/params';
import { gradeOptions } from '@/lib/srs/session';

/**
 * Fitting FSRS to this learner (PLAN.md §3.3, Phase 8 item 2 and 3).
 *
 * The panel's job is to make an honest offer and let a person decide. Three
 * things it must never do, all of which it would be easy to do by accident:
 *
 * 1. **Apply a fit on its own.** The Run button produces a proposal and two
 *    numbers; the Apply button is a separate press.
 * 2. **Quote a number the fit was trained on.** Both losses shown are held-out
 *    losses — the reviews the search never saw — and they are labelled as such.
 * 3. **Promise more than it has.** Below the floor it says the floor is a floor
 *    for signal, not a guarantee, because it is: real FSRS optimization wants
 *    well over a thousand reviews and 400 is where the exercise stops being
 *    pure noise.
 *
 * The search runs in chunks with a yield between them (`optimizeWeights` yields
 * through `setTimeout`), so a few hundred replays of the review log do not
 * freeze the tab, and the Cancel button is honoured between chunks.
 */

const DAY_MS = 86_400_000;

/** `1,240` — grouped the same way on every machine, no locale in the loop. */
function grouped(value: number): string {
  return String(Math.max(0, Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Log-loss, to the digits that actually differ between two parameter sets. */
const loss = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? '—' : value.toFixed(4);

/**
 * A Review-state card with the given stability, for the "what would change"
 * table. Not a real card: it is a worked example, and it is labelled as one.
 */
function sampleCard(stabilityDays: number, now: number): FsrsCardState {
  return {
    state: 2,
    due: now,
    stability: stabilityDays,
    difficulty: 5,
    reps: 4,
    lapses: 0,
    scheduled_days: Math.round(stabilityDays),
    learning_steps: 0,
    last_review: now - stabilityDays * DAY_MS,
  };
}

const SAMPLES = [1, 10, 60] as const;

export interface OptimizerPanelProps {
  settings: SettingsRow;
  /** Called with the row the repository wrote, so the form stays in step. */
  onSettings: (settings: SettingsRow) => void;
}

export function OptimizerPanel({ settings, onSettings }: OptimizerPanelProps) {
  const [scorable, setScorable] = useState<number>();
  const [total, setTotal] = useState<number>();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<OptimizeResult>();
  /** The instant the result landed. The preview table is drawn against it, so
   *  a re-render does not redraw the same table from a different clock. */
  const [resultAt, setResultAt] = useState(0);
  const [status, setStatus] = useState<string>();
  const [previous, setPrevious] = useState<PreviousWeights | undefined>();
  const [busy, setBusy] = useState(false);
  const reviews = useRef<ReviewRow[]>([]);
  const abort = useRef<AbortController>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);

  // The log is read once and kept: it is what the count is from and what the
  // run is over, and reading it twice would let the two disagree.
  useEffect(() => {
    let cancelled = false;
    void getRepository()
      .allReviewsChronological()
      .then((rows) => {
        if (cancelled) return;
        reviews.current = rows;
        const set = buildTrainingSet(rows);
        setScorable(set.scorableReviews);
        setTotal(set.totalReviews);
        setPrevious(readPrevious());
      })
      .catch((error: unknown) =>
        setStatus(error instanceof Error ? error.message : String(error)),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async () => {
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setProgress(0);
    setResult(undefined);
    setStatus(undefined);
    try {
      const outcome = await optimizeWeights({
        reviews: reviews.current,
        settings,
        signal: controller.signal,
        onProgress: (update) => {
          if (alive.current) setProgress(update.total === 0 ? 0 : update.done / update.total);
        },
      });
      if (!alive.current) return;
      setResult(outcome);
      setResultAt(Date.now());
    } catch (error) {
      if (alive.current) setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current) setRunning(false);
      abort.current = undefined;
    }
  }, [settings]);

  const apply = useCallback(async () => {
    if (!result?.fit) return;
    setBusy(true);
    try {
      // Parked *before* the write, so Revert has somewhere to go back to.
      rememberPrevious(settings.fsrsWeights ?? null);
      const next = await getRepository().setSettings({ fsrsWeights: result.fit });
      onSettings(next);
      setPrevious(readPrevious());
      setResult(undefined);
      setStatus('Your parameters are in force. Every card is scheduled by them from now on.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [result, settings.fsrsWeights, onSettings]);

  const revert = useCallback(async () => {
    setBusy(true);
    try {
      const target = previous ?? null;
      const next = await getRepository().setSettings({ fsrsWeights: target });
      onSettings(next);
      forgetPrevious();
      setPrevious(undefined);
      setStatus(
        target === null
          ? 'Back to the FSRS defaults.'
          : 'Back to the parameters you had before.',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [previous, onSettings]);

  const enough = (scorable ?? 0) >= MIN_REVIEWS_FOR_FIT;
  const optimized = settings.fsrsWeights !== null;
  const canRevert = previous !== undefined || optimized;

  return (
    <div data-testid="optimizer-panel" className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Fit the schedule to your history</p>
        <p data-testid="optimizer-source" className="text-xs text-muted">
          {describeParameters(settings)}
        </p>
      </div>

      <p className="text-xs text-muted">
        FSRS ships with parameters fitted to a large population of learners. Given enough of your
        own reviews it can be fitted to <em>you</em> instead — to what you have actually remembered
        and forgotten, and how long you left each card. It is a tuning, not magic: it changes how
        far apart your reviews are, not whether you do them.
      </p>

      <p data-testid="optimizer-review-count" className="text-xs text-muted">
        {scorable === undefined
          ? 'Counting your reviews…'
          : `${grouped(scorable)} of your ${grouped(total ?? 0)} reviews can be scored — a card's very first review has no memory state to predict from, so it is replayed and not counted.`}
      </p>

      {scorable !== undefined && !enough ? (
        <p data-testid="optimizer-floor" className="text-xs text-warning">
          The fit needs at least {grouped(MIN_REVIEWS_FOR_FIT)} scorable reviews before it will run
          at all, and that number is a floor for signal rather than a guarantee of one: real FSRS
          optimization wants well over a thousand. Until then the population defaults are the
          better bet, and reviewing is the only thing that changes it.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          data-testid="optimizer-run"
          disabled={!enough || running || busy}
          onClick={() => void run()}
        >
          {running ? `Fitting… ${Math.round(progress * 100)}%` : 'Run the fit'}
        </Button>
        {running ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="optimizer-cancel"
            onClick={() => abort.current?.abort()}
          >
            Cancel
          </Button>
        ) : null}
        {canRevert && !running ? (
          <Button
            size="sm"
            variant="secondary"
            data-testid="optimizer-revert"
            disabled={busy}
            onClick={() => void revert()}
          >
            {previous ? 'Revert to the previous fit' : 'Revert to FSRS defaults'}
          </Button>
        ) : null}
      </div>

      {result ? (
        <OptimizerResult
          result={result}
          settings={settings}
          now={resultAt}
          onApply={apply}
          busy={busy}
        />
      ) : null}

      {status ? (
        <p role="status" data-testid="optimizer-status" className="text-xs text-muted">
          {status}
        </p>
      ) : null}
    </div>
  );
}

function OptimizerResult({
  result,
  settings,
  now,
  onApply,
  busy,
}: {
  result: OptimizeResult;
  settings: SettingsRow;
  /** The instant the fit finished — the clock the preview table is drawn at. */
  now: number;
  onApply: () => Promise<void>;
  busy: boolean;
}) {
  if (result.status === 'cancelled') {
    return (
      <p data-testid="optimizer-result" className="text-xs text-muted">
        Stopped. Nothing was changed.
      </p>
    );
  }
  if (result.status === 'not-enough-data') {
    return (
      <p data-testid="optimizer-result" className="text-xs text-warning">
        Not enough reviews to fit anything yet.
      </p>
    );
  }

  const held = `${grouped(result.heldOutCount)} held-out ${result.heldOutCount === 1 ? 'review' : 'reviews'}`;
  const scores = (
    <p data-testid="optimizer-scores" className="text-xs text-muted">
      Fitted on {grouped(result.trainCount)}, scored on the {held} it never saw — the newest slice
      of your history, kept back on purpose. Log-loss, lower is better:{' '}
      <strong data-testid="optimizer-loss-fitted">{loss(result.fittedLoss)}</strong> for the fit
      against <strong data-testid="optimizer-loss-current">{loss(result.currentLoss)}</strong> for
      what you are running now.
    </p>
  );

  if (result.status !== 'ok' || !result.fit) {
    return (
      <div data-testid="optimizer-result" className="flex flex-col gap-2">
        {scores}
        <p className="text-xs text-warning">
          The fit did not beat the parameters you already have, so there is nothing to apply. That
          is the check doing its job, not a failure: a fit that only looks better on the reviews it
          was trained on would make your schedule worse for months before you noticed.
        </p>
      </div>
    );
  }

  // The candidate is a *usable* fit by construction here, so it resolves
  // through `params.ts` exactly as it would once applied — this table is the
  // scheduler answering, not a re-implementation of it.
  const after = { ...settings, fsrsWeights: result.fit };

  return (
    <div data-testid="optimizer-result" className="flex flex-col gap-2">
      {scores}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3 font-normal">A card you remember, last seen</th>
              <th className="py-1 pr-3 font-normal">Now</th>
              <th className="py-1 font-normal">After</th>
            </tr>
          </thead>
          <tbody data-testid="optimizer-preview">
            {SAMPLES.map((days) => {
              const card = sampleCard(days, now);
              return (
                <tr key={days} className="border-t border-border">
                  <td className="py-1 pr-3">{days === 1 ? 'a day ago' : `${days} days ago`}</td>
                  <td className="py-1 pr-3">{gradeOptions(card, now, settings)[2].interval}</td>
                  <td className="py-1">{gradeOptions(card, now, after)[2].interval}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Worked examples, not your cards: what &ldquo;Good&rdquo; would schedule for a card of that
        age at average difficulty. Applying changes nothing you have already answered — no review
        is rewritten, and every card keeps the state it is in.
      </p>
      <div>
        <Button size="sm" data-testid="optimizer-apply" disabled={busy} onClick={() => void onApply()}>
          Use these parameters
        </Button>
      </div>
    </div>
  );
}
