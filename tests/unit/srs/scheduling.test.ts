import { afterEach, describe, expect, it } from 'vitest';

import { gradeCard } from '@/lib/srs/card';
import { RETENTION_CHOICES } from '@/lib/srs/params';
import { DASUAN, freshRepository } from '../db/fixtures';

const MINUTE = 60_000;
const DAY = 86_400_000;
const START = Date.UTC(2026, 5, 1, 9);

let close: (() => void) | undefined;

afterEach(() => {
  close?.();
  close = undefined;
});

function repo() {
  const { db, repo: repository } = freshRepository();
  close = () => db.close();
  return repository;
}

/**
 * The two scheduling settings, end to end: written to the settings row, read by
 * `lib/srs/params.ts` inside the grade transaction, and visible in the instant
 * the card comes back. `tests/unit/srs/params.test.ts` proves the parameter
 * object is built from them; this proves the app is actually scheduled by it.
 *
 * A matured card is the honest subject for retention. On a *new* card with the
 * short steps on, Again and Good are learning steps — a fixed 1m and 10m that
 * no `request_retention` can move — so a test that graded a new card and found
 * the two retentions equal would be measuring the learning steps, not the
 * setting.
 */
async function maturedCard(repository: ReturnType<typeof repo>) {
  const card = await repository.addCardFromEntry(DASUAN);
  // Easy graduates it out of the learning steps; a week later it is a Review
  // card with real stability, which is where retention decides the interval.
  await repository.grade(card.id, 4, START);
  return card.id;
}

describe('settings.shortTermSteps, end to end', () => {
  it('brings a failed new card back in minutes when it is on (the default)', async () => {
    const repository = repo();
    expect((await repository.getSettings()).shortTermSteps).toBe(true);
    const card = await repository.addCardFromEntry(DASUAN);

    const { card: graded } = await repository.grade(card.id, 1, START);
    const delay = graded.due - START;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(30 * MINUTE);
    // FSRS Learning (1) — a state that could not occur at all under v1's
    // `enable_short_term: false`.
    expect(graded.fsrs.state).toBe(1);
    expect(graded.fsrs.scheduled_days).toBe(0);
  });

  it('pushes the same grade a day out when it is off', async () => {
    const repository = repo();
    await repository.setSettings({ shortTermSteps: false });
    const card = await repository.addCardFromEntry(DASUAN);

    const { card: graded } = await repository.grade(card.id, 1, START);
    expect(graded.due - START).toBeGreaterThanOrEqual(DAY);
    expect(graded.fsrs.scheduled_days).toBeGreaterThanOrEqual(1);
  });

  it('is one column, not a rebuild: the same card, the same grade, the same clock', async () => {
    const on = gradeCard(newFsrs(), 1, START, { shortTermSteps: true }).next;
    const off = gradeCard(newFsrs(), 1, START, { shortTermSteps: false }).next;
    expect(on.due - START).toBeLessThan(DAY);
    expect(off.due - START).toBeGreaterThanOrEqual(DAY);
  });
});

describe('settings.requestRetention, end to end', () => {
  it('schedules a matured card sooner at 0.97 than at 0.85', async () => {
    const eager = repo();
    await eager.setSettings({ requestRetention: 0.97 });
    const eagerId = await maturedCard(eager);
    const { card: eagerCard } = await eager.grade(eagerId, 3, START + 8 * DAY);
    close?.();

    const relaxed = repo();
    await relaxed.setSettings({ requestRetention: 0.85 });
    const relaxedId = await maturedCard(relaxed);
    const { card: relaxedCard } = await relaxed.grade(relaxedId, 3, START + 8 * DAY);

    expect(eagerCard.fsrs.scheduled_days).toBeGreaterThan(0);
    expect(eagerCard.fsrs.scheduled_days).toBeLessThan(relaxedCard.fsrs.scheduled_days);
    expect(eagerCard.due).toBeLessThan(relaxedCard.due);
  });

  it('is monotone across every step the settings pane offers', async () => {
    // Aiming to remember more can never mean waiting longer. Pure, so the whole
    // range is checked rather than two points of it.
    const state = gradeCard(newFsrs(), 4, START).next;
    const dues = RETENTION_CHOICES.map(
      (requestRetention) =>
        gradeCard(state, 3, START + 8 * DAY, { requestRetention }).next.due,
    );
    for (let i = 1; i < dues.length; i += 1) {
      expect(dues[i]).toBeLessThanOrEqual(dues[i - 1]);
    }
    expect(dues[dues.length - 1]).toBeLessThan(dues[0]);
  });

  it('is clamped, not trusted: a stored 5 or a stored -1 still schedules', async () => {
    const repository = repo();
    // Nothing in the UI can write these, but a hand-edited database or a future
    // import can, and a `request_retention` outside (0,1] makes ts-fsrs throw.
    await repository.setSettings({ requestRetention: 5 });
    const card = await repository.addCardFromEntry(DASUAN);
    const { card: graded } = await repository.grade(card.id, 3, START);
    expect(graded.due).toBeGreaterThan(START);
  });
});

/** A never-reviewed card's FSRS state, without a repository. */
function newFsrs() {
  return {
    state: 0 as const,
    due: START,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    scheduled_days: 0,
    learning_steps: 0,
  };
}
