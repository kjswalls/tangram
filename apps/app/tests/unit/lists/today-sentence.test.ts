/**
 * Today is a sentence (docs/plans/core.md C8; product-decisions §2).
 *
 * The tiles were rejected because they were the most prominent thing on the
 * screen and are not the most important thing on it. What replaces them has one
 * rule that a hardcoded string would not have: **a clause whose count is zero
 * is not in the sentence.** "8 words to practice, 0 new words to learn, and 0
 * to write from memory" is the tile grid again, with commas.
 *
 * The duration is the other half. C8 is explicit that it must not be invented,
 * so `lib/srs/pace.ts` derives it from the learner's own median gap between
 * reviews and falls back to one named, honestly-labelled placeholder. These
 * tests hold both: that the median is used once there is one, and that a single
 * twenty-minute interruption cannot decide the estimate.
 */
import { describe, expect, it } from 'vitest';

import {
  NOTHING_WAITING,
  countsClause,
  joinClauses,
  todaySentence,
  totalItems,
} from '@/lib/lists/today-sentence';
import {
  DEFAULT_SECONDS_PER_REVIEW,
  MIN_SAMPLES,
  SESSION_GAP_MS,
  describeMinutes,
  estimateMinutes,
  medianSecondsPerReview,
} from '@/lib/srs/pace';

describe('the sentence', () => {
  it('reads the way C8 writes it', () => {
    // The plan's own example, at the placeholder pace: 15 items × 8 s = 120 s.
    expect(todaySentence({ practice: 8, fresh: 5, write: 2 }, DEFAULT_SECONDS_PER_REVIEW)).toBe(
      '8 words to practice, 5 new words to learn, and 2 to write from memory. About two minutes.',
    );
  });

  it('drops every clause whose count is zero', () => {
    expect(countsClause({ practice: 8, fresh: 0, write: 0 })).toBe('8 words to practice');
    expect(countsClause({ practice: 0, fresh: 5, write: 0 })).toBe('5 new words to learn');
    expect(countsClause({ practice: 0, fresh: 0, write: 2 })).toBe('2 to write from memory');
    expect(countsClause({ practice: 8, fresh: 0, write: 2 })).toBe(
      '8 words to practice and 2 to write from memory',
    );
    for (const clause of [
      countsClause({ practice: 8, fresh: 0, write: 0 }),
      countsClause({ practice: 8, fresh: 0, write: 2 }),
    ]) {
      expect(clause).not.toContain('0 ');
    }
  });

  it('says one word rather than 1 words', () => {
    expect(countsClause({ practice: 1, fresh: 1, write: 1 })).toBe(
      '1 word to practice, 1 new word to learn, and 1 to write from memory',
    );
  });

  it('has something to say when there is nothing to do', () => {
    expect(todaySentence({ practice: 0, fresh: 0, write: 0 }, DEFAULT_SECONDS_PER_REVIEW)).toBe(
      NOTHING_WAITING,
    );
    expect(NOTHING_WAITING).not.toMatch(/due|card|interval|review/i);
  });

  it('joins with the Oxford comma, and with none at all for two', () => {
    expect(joinClauses([])).toBe('');
    expect(joinClauses(['a'])).toBe('a');
    expect(joinClauses(['a', 'b'])).toBe('a and b');
    expect(joinClauses(['a', 'b', 'c'])).toBe('a, b, and c');
  });

  it('counts every kind toward the estimate', () => {
    expect(totalItems({ practice: 8, fresh: 5, write: 2 })).toBe(15);
  });

  it('never shows a false precision', () => {
    expect(describeMinutes(0)).toBe('');
    expect(describeMinutes(1)).toBe('About a minute.');
    expect(describeMinutes(6)).toBe('About six minutes.');
    expect(describeMinutes(40)).toBe('About 40 minutes.');
    // One item is never "0 minutes".
    expect(estimateMinutes(1, 8)).toBe(1);
    expect(estimateMinutes(0, 8)).toBe(0);
    expect(estimateMinutes(45, 8)).toBe(6);
  });
});

describe('the learner’s own pace', () => {
  const log = (gapsSeconds: readonly number[]) => {
    let at = Date.UTC(2026, 8, 16, 9);
    const rows = [{ reviewedAt: at }];
    for (const gap of gapsSeconds) {
      at += gap * 1000;
      rows.push({ reviewedAt: at });
    }
    return rows;
  };

  it('is unknown until there is enough of it', () => {
    expect(medianSecondsPerReview([])).toBeUndefined();
    expect(medianSecondsPerReview(log(Array.from({ length: MIN_SAMPLES - 1 }, () => 5)))).toBeUndefined();
    expect(medianSecondsPerReview(log(Array.from({ length: MIN_SAMPLES }, () => 5)))).toBe(5);
  });

  it('is a median, so one cup of tea does not decide it', () => {
    // Nineteen five-second reviews and one that took eleven minutes. A mean
    // would report 38 seconds a card and tell the learner their ten-card
    // session takes six minutes.
    const gaps = [...Array.from({ length: 19 }, () => 5), 11 * 60];
    expect(medianSecondsPerReview(log(gaps))).toBe(5);
  });

  it('drops the gaps between sittings rather than clamping them', () => {
    // A gap over the session boundary is not a slow review, and clamping it to
    // five minutes would still say the learner spent five minutes on one card.
    const gaps = [...Array.from({ length: 12 }, () => 4), SESSION_GAP_MS / 1000 + 1];
    expect(medianSecondsPerReview(log(gaps))).toBe(4);
  });

  it('ignores a replayed or seeded log rather than reporting zero', () => {
    const rows = Array.from({ length: 30 }, () => ({ reviewedAt: Date.UTC(2026, 8, 16, 9) }));
    expect(medianSecondsPerReview(rows)).toBeUndefined();
  });

  it('has a placeholder that is labelled as one, not dressed up as a measurement', () => {
    expect(DEFAULT_SECONDS_PER_REVIEW).toBeGreaterThan(0);
    expect(DEFAULT_SECONDS_PER_REVIEW).toBeLessThan(60);
  });
});
