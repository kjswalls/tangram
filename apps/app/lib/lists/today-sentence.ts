/**
 * Today, as a sentence (docs/plans/core.md C8; product-decisions §2).
 *
 * The three number tiles were tried and rejected: they were the most prominent
 * thing on the screen and they are not the most important thing on it. What
 * replaces them is one line of English —
 *
 *   "8 words to practise, 5 new words to learn, and 2 to write from memory.
 *    About six minutes."
 *
 * (C8's own example spells the verb "practice"; every other learner-visible
 * string in the app spells it "practise", so the app's spelling wins. Recorded
 * in HANDOFF.md.)
 *
 * — and the rule that makes it worth building rather than hardcoding is that
 * **every clause is dropped when its count is zero**. A learner with no new
 * words should read "8 words to practise. About one minute.", not "…, 0 new
 * words to learn, …". A sentence that lists zeroes is a tile grid with commas.
 *
 * This module is pure so the wording is unit-testable; `components/screens/today.tsx`
 * supplies the counts and the pace.
 */

import { describeMinutes, estimateMinutes } from '@/lib/srs/pace';

export interface TodayCounts {
  /** Recognition cards already waiting: "N words to practise". */
  practice: number;
  /** What the session will introduce: "N new words to learn". */
  fresh: number;
  /** Production cards waiting: "N to write from memory". */
  write: number;
}

/**
 * What the sentence says when there is nothing at all.
 *
 * **"your next session", not "tomorrow".** An explicitly added card is in
 * *today's* queue by design and uncapped (`lib/lists/queue.ts`: "an explicitly
 * added card … is *always* in today's queue"), so promising tomorrow was
 * simply wrong — and it contradicted the two other surfaces that state the same
 * fact. Found by C8's adversarial review.
 */
export const NOTHING_WAITING =
  'Nothing waiting — look a word up and it joins your next session.';

export function totalItems(counts: TodayCounts): number {
  return counts.practice + counts.fresh + counts.write;
}

/** "a, b, and c" — the Oxford comma, and no comma at all for two. */
export function joinClauses(clauses: readonly string[]): string {
  if (clauses.length === 0) return '';
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
}

/** The counts half of the sentence, with zero clauses dropped. */
export function countsClause(counts: TodayCounts): string {
  const clauses: string[] = [];
  if (counts.practice > 0) {
    clauses.push(`${counts.practice} ${counts.practice === 1 ? 'word' : 'words'} to practise`);
  }
  if (counts.fresh > 0) {
    clauses.push(`${counts.fresh} new ${counts.fresh === 1 ? 'word' : 'words'} to learn`);
  }
  if (counts.write > 0) {
    /**
     * **The writing clause carries its own noun when it leads.** It borrows one
     * from the clause in front of it — "8 words to practise, and 2 to write
     * from memory" — and a learner whose only waiting cards are production
     * twins read the whole of Today as "5 to write from memory." Five what?
     * Found by C8's adversarial review.
     */
    const noun = clauses.length === 0 ? `${counts.write === 1 ? 'word' : 'words'} ` : '';
    clauses.push(`${counts.write} ${noun}to write from memory`);
  }
  return joinClauses(clauses);
}

/**
 * The whole line. `secondsPerItem` is the learner's own median where there is
 * one and the named placeholder where there is not (`lib/srs/pace.ts`).
 */
export function todaySentence(counts: TodayCounts, secondsPerItem: number): string {
  const items = totalItems(counts);
  if (items === 0) return NOTHING_WAITING;
  const duration = describeMinutes(estimateMinutes(items, secondsPerItem));
  return `${countsClause(counts)}. ${duration}`.trim();
}
