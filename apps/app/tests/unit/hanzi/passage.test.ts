/**
 * The gallery passage is generated, and this is what keeps it generated
 * (core.md C3).
 *
 * `components/gallery/passage.ts` is a committed snapshot of
 * `segment(DEMO_PARAGRAPH)` with each token's first reading attached. Committed
 * so the gallery does not pull the dictionary index into its bundle — which
 * means it can go stale silently if the segmenter, the dictionary or the
 * paragraph moves. It would go stale in the one way that matters: a *wrong*
 * reading over a character, which is the failure the whole ruby phase exists to
 * prevent, and which no wrapping or layout assertion would notice.
 *
 * So the fixture is re-derived here and compared whole.
 */
import { describe, expect, it } from 'vitest';

import { PASSAGE_RUNS, passageRuns } from '@/components/gallery/passage';
import { getEntries } from '@/lib/dict/index';
import { segment } from '@/lib/dict/segment';

import { DEMO_PARAGRAPH } from '../../e2e/p5/paragraph';

/**
 * The generator, verbatim — including the polyphone rule.
 *
 * A token whose entries disagree on the reading gets none. `entryIds[0]` is
 * the most frequent entry, not the contextually cited one, and the first cut
 * of this fixture used it: it printed jì over 骑 in 骑自行车 and páo over 跑 in
 * 跑完步. This function reproducing that would not have caught it — see the
 * case below, which names the characters rather than re-deriving them.
 */
function derive() {
  return segment(DEMO_PARAGRAPH).tokens.map((token) => {
    const entries = getEntries(token.entryIds);
    // Case-insensitively, so a proper-noun capitalisation (Shui3 beside shui3)
    // is not mistaken for a second reading.
    const readings = new Set(entries.map((entry) => entry.pinyinNum.toLowerCase()));
    return readings.size === 1 && entries[0]
      ? { text: token.text, pinyinNum: entries[0].pinyinNum }
      : { text: token.text };
  });
}

describe('the gallery passage', () => {
  it('still matches what the segmenter and the dictionary produce', () => {
    expect(PASSAGE_RUNS).toEqual(derive());
  });

  it('covers the paragraph exactly, in order', () => {
    expect(PASSAGE_RUNS.map((run) => run.text).join('')).toBe(DEMO_PARAGRAPH);
  });

  /**
   * **Named, not derived.** Every other case here runs the generator again, so
   * a bug in the generator reproduces itself and passes. These characters are
   * the ones whose wrong readings shipped, spelled out by hand: 骑 read jì
   * (cavalry) inside 骑自行车去上班, 跑 read páo inside 跑完步, and 要 and 看
   * read in their rarer tones. The claim is not "the generator agrees with
   * itself" but "these four characters carry no reading at all", which is the
   * only honest thing to print over a polyphone nothing has disambiguated.
   */
  it('prints no reading over a polyphone the paragraph does not disambiguate', () => {
    for (const text of ['骑', '跑', '要', '看', '会', '的', '和', '东西']) {
      const runs = PASSAGE_RUNS.filter((run) => run.text === text);
      expect(runs.length, `${text} is not in the passage any more`).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run.pinyinNum, `${text} carries a guessed reading`).toBeUndefined();
      }
    }
    // And a word that is NOT a polyphone still carries one, so the rule is not
    // "drop everything".
    expect(PASSAGE_RUNS.find((run) => run.text === '跑步')?.pinyinNum).toBe('pao3 bu4');
    expect(PASSAGE_RUNS.find((run) => run.text === '每天')?.pinyinNum).toBe('mei3 tian1');
  });

  it('gives a reading to every run the dictionary knows, and none to punctuation', () => {
    const punctuation = PASSAGE_RUNS.filter((run) => /^[，。、]+$/u.test(run.text));
    expect(punctuation.length).toBeGreaterThan(0);
    for (const run of punctuation) expect(run.pinyinNum).toBeUndefined();
    // Not a bare `some`: the criteria are about a passage that is mostly
    // annotated, and a fixture that lost its readings would still wrap fine.
    const withReading = PASSAGE_RUNS.filter((run) => run.pinyinNum).length;
    expect(withReading).toBeGreaterThan(PASSAGE_RUNS.length / 2);
  });

  it('repeats to at least the length asked for, whole paragraphs at a time', () => {
    const long = passageRuns(500);
    const chars = long.map((run) => run.text).join('');
    expect(chars.length).toBeGreaterThanOrEqual(500);
    expect(chars.length % DEMO_PARAGRAPH.length).toBe(0);
    expect(long.length % PASSAGE_RUNS.length).toBe(0);
  });
});
