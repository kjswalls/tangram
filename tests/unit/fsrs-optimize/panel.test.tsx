/**
 * The optimizer panel (Phase 8 item 3).
 *
 * What is worth testing here is not the layout: it is that the panel cannot
 * cheat. It must refuse to run below the floor, it must never apply a fit by
 * itself, the numbers it quotes must be the held-out ones, and Revert must
 * actually put back what was there.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { default_w } from 'ts-fsrs';

import { OptimizerPanel } from '@/components/settings/optimizer-panel';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import type { SettingsRow } from '@/lib/db/schema';
import { resetAll } from '@/lib/dev/seed';
import { MIN_REVIEWS_FOR_FIT, rememberPrevious } from '@/lib/fsrs-optimize';
import { clipWeights } from '@/lib/srs/params';
import { syntheticReviews } from './synthetic';

afterEach(async () => {
  localStorage.clear();
  await getDb().delete();
  await closeDb();
});

/** A learner unlike the population — the same one the optimizer tests use. */
const KNOWN = clipWeights(
  default_w.map((value, index) => {
    if (index < 4) return value * 2;
    if (index === 4) return value * 0.75;
    if (index === 5) return value * 1.4;
    if (index === 6) return value * 0.6;
    if (index === 8) return value * 1.6;
    if (index === 9) return value * 0.4;
    if (index === 10) return value * 1.7;
    if (index === 11) return value * 1.5;
    if (index === 20) return 0.3;
    return value;
  }),
);

/** The panel plus the one thing its host does: hold the settings row. */
function Harness({ initial }: { initial: SettingsRow }) {
  const [settings, setSettings] = useState(initial);
  return <OptimizerPanel settings={settings} onSettings={setSettings} />;
}

async function seedReviews(options: { w: readonly number[]; cards: number; per: number; seed: number }) {
  const rows = syntheticReviews({
    w: options.w,
    cards: options.cards,
    reviewsPerCard: options.per,
    seed: options.seed,
  });
  await getDb().reviews.bulkAdd(rows);
  return rows.length;
}

async function mount() {
  const settings = await getRepository().getSettings();
  render(<Harness initial={settings} />);
  return settings;
}

describe('the optimizer panel', () => {
  it('will not run below the floor, and says the floor is a floor for signal', async () => {
    await seedReviews({ w: KNOWN, cards: 20, per: 5, seed: 4 });
    await mount();

    await waitFor(() => expect(screen.getByTestId('optimizer-floor')).toBeInTheDocument());
    expect(screen.getByTestId('optimizer-floor')).toHaveTextContent(
      /floor for signal rather than a guarantee/,
    );
    expect(screen.getByTestId('optimizer-run')).toBeDisabled();
    expect(screen.getByTestId('optimizer-review-count')).toHaveTextContent(
      /\d+ of your \d+ reviews can be scored/,
    );
  });

  it('runs, shows both held-out losses, and applies nothing until asked', async () => {
    await seedReviews({ w: KNOWN, cards: 250, per: 8, seed: 7 });
    await mount();

    const run = await screen.findByTestId('optimizer-run');
    await waitFor(() => expect(run).toBeEnabled());
    expect(screen.queryByTestId('optimizer-floor')).toBeNull();

    run.click();
    const result = await screen.findByTestId('optimizer-result', undefined, { timeout: 60_000 });
    expect(result).toBeInTheDocument();

    const fitted = Number(screen.getByTestId('optimizer-loss-fitted').textContent);
    const current = Number(screen.getByTestId('optimizer-loss-current').textContent);
    expect(Number.isFinite(fitted)).toBe(true);
    expect(fitted).toBeLessThan(current);
    expect(screen.getByTestId('optimizer-scores')).toHaveTextContent(/it never saw/);
    // Two four-decimal losses side by side read as a measurement; the margin
    // between them is often smaller than the error on it, and that is the case
    // the learner cannot see. So the panel quotes the margin *and* its error.
    expect(screen.getByTestId('optimizer-margin')).toHaveTextContent(
      /better by 0\.\d{4} per review, give or take 0\.\d{4} \(one standard error\), which is clear of its own noise/,
    );

    // A run is a proposal. Nothing has been written.
    expect((await getRepository().getSettings()).fsrsWeights).toBeNull();
    expect(screen.getByTestId('optimizer-source')).toHaveTextContent('FSRS defaults');

    // The preview is the scheduler answering, three worked examples of it.
    expect(screen.getByTestId('optimizer-preview').querySelectorAll('tr')).toHaveLength(3);

    screen.getByTestId('optimizer-apply').click();
    await waitFor(async () => {
      const stored = await getRepository().getSettings();
      expect(stored.fsrsWeights).not.toBeNull();
    });
    const stored = await getRepository().getSettings();
    expect(stored.fsrsWeights!.w).toHaveLength(default_w.length);
    expect(stored.fsrsWeights!.heldOutLogLoss).toBeLessThan(stored.fsrsWeights!.baselineLogLoss);
    await waitFor(() =>
      expect(screen.getByTestId('optimizer-source')).toHaveTextContent(/^Optimized from your/),
    );

    // And one press puts it back.
    screen.getByTestId('optimizer-revert').click();
    await waitFor(async () => {
      expect((await getRepository().getSettings()).fsrsWeights).toBeNull();
    });
    await waitFor(() =>
      expect(screen.getByTestId('optimizer-source')).toHaveTextContent('FSRS defaults'),
    );
  }, 120_000);

  it('says so plainly when the fit did not beat what is already in force', async () => {
    // Generated from the population defaults, so there is nothing to find.
    await seedReviews({ w: default_w, cards: 300, per: 10, seed: 11 });
    await mount();

    const run = await screen.findByTestId('optimizer-run');
    await waitFor(() => expect(run).toBeEnabled());
    run.click();

    const result = await screen.findByTestId('optimizer-result', undefined, { timeout: 60_000 });
    expect(result).toHaveTextContent(/did not beat the parameters you already have/);
    expect(result).toHaveTextContent(/the check doing its job/);
    // And it says which way it fell: worse, or better by less than the noise.
    expect(screen.getByTestId('optimizer-margin').textContent ?? '').toMatch(
      /(worse by 0\.\d{4} per review|inside the noise of the measurement)/,
    );
    // No Apply button at all — there is nothing to apply.
    expect(screen.queryByTestId('optimizer-apply')).toBeNull();
    expect((await getRepository().getSettings()).fsrsWeights).toBeNull();
  }, 120_000);

  it('offers a revert to the defaults whenever a fit is in force', async () => {
    await seedReviews({ w: KNOWN, cards: 20, per: 5, seed: 4 });
    const settings = await getRepository().setSettings({
      fsrsWeights: {
        w: [...KNOWN],
        fittedAt: Date.UTC(2026, 2, 3),
        reviewCount: 1240,
        heldOutLogLoss: 0.31,
        baselineLogLoss: 0.34,
      },
    });
    render(<Harness initial={settings} />);

    // Below the floor, so Run is out — but a fit already in force can always be
    // undone, whether or not there are enough reviews to make a new one.
    const revert = await screen.findByTestId('optimizer-revert');
    expect(revert).toHaveTextContent('Revert to FSRS defaults');
    revert.click();
    await waitFor(async () => {
      expect((await getRepository().getSettings()).fsrsWeights).toBeNull();
    });
    expect(await screen.findByTestId('optimizer-status')).toHaveTextContent(
      'Back to the FSRS defaults.',
    );
  });

  /**
   * The reviewer's reproduction, at the panel.
   *
   * Park a fit in the slot, wipe the database from the Reset button two
   * sections down the same page, and the panel used to keep offering "Revert to
   * the previous fit" — one click, and `describeParameters` said "Optimized
   * from your 4,321 reviews" over a database holding none.
   */
  it('offers no undo of a fit the database no longer has', async () => {
    const applied = {
      w: [...KNOWN],
      fittedAt: Date.UTC(2026, 2, 3),
      reviewCount: 4321,
      heldOutLogLoss: 0.31,
      baselineLogLoss: 0.34,
    };
    rememberPrevious(null, applied.fittedAt);
    // The wipe: every table cleared, and the settings row back to its defaults.
    await resetAll(getRepository());

    const settings = await getRepository().getSettings();
    expect(settings.fsrsWeights).toBeNull();
    render(<Harness initial={settings} />);

    await waitFor(() =>
      expect(screen.getByTestId('optimizer-review-count')).toHaveTextContent(/0 of your 0/),
    );
    expect(screen.queryByTestId('optimizer-revert')).toBeNull();
  });

  it('names the floor it enforces', () => {
    // Raised from 400 with the significance gate (see optimize.ts): at 400 the
    // held-out half is 80-odd answers and a null log was offered a fit in 9 of
    // 24 runs. If this number ever comes back down, the measurements in
    // `noise-gate.test.ts` are what has to move first.
    expect(MIN_REVIEWS_FOR_FIT).toBe(1000);
  });
});
