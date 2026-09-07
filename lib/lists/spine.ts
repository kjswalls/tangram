/**
 * Which dictionary entries the auto-draw may introduce (PLAN.md §3.3).
 *
 * §3.3's draw order ends "…active spine bands from `settings.spineStartBand`
 * upward, freq order within band, skipping `isVariant`/`properNoun`". Read
 * literally that skip drops 113 HSK words from the spine — 中国, 汉语, 北京,
 * 星期天 are `properNoun`; 一点儿, 一块儿, 好玩儿, 小孩儿 are `isVariant`
 * because CC-CEDICT glosses them "erhua variant of …" — including six of band 1.
 * A spine that cannot teach 中国 is not the HSK spine.
 *
 * So the skip applies only where it has real work to do: entries the HSK list
 * does not carry. Inside a band the standard has already decided the word is
 * vocabulary, and Tangram does not overrule it.
 */

import type { Entry } from '@/lib/types';

/** The fields the rule needs; anything Entry-shaped satisfies it. */
export type SpineCandidate = Pick<Entry, 'hskBand' | 'isVariant' | 'properNoun'>;

export function spineEligible(entry: SpineCandidate): boolean {
  // HSK put it in a band: it is on the syllabus, variant spelling or not.
  if (entry.hskBand !== undefined) return true;
  return !entry.isVariant && !entry.properNoun;
}
