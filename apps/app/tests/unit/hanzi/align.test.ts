/**
 * Syllable-to-character alignment (docs/plans/core.md C3; risk R5).
 *
 * R5 is that a wrong per-character reading is a **silent teaching error**: the
 * whole product promise is that hanzi and tone marks are rendered from cited
 * dictionary data, and a beginner cannot tell a mis-zipped reading from a right
 * one. So the cases below are named individually, and the property test at the
 * bottom runs over real `data/dict.json` entries and records the fallback rate —
 * because a rule that falls back on a tenth of the dictionary is not a rule, it
 * is a rendering bug with an alibi.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { alignReading, isReadingPunctuation } from '@/lib/hanzi/align';
import { dataDir } from '@/lib/server/roots';
import type { DictFile } from '@/lib/types';

describe('the cases that break a naive zip', () => {
  it('打算 — the clean two-and-two', () => {
    const result = alignReading('打算', 'da3 suan4');
    expect(result.mode).toBe('aligned');
    expect(result.chars).toEqual([
      { char: '打', syllable: 'dǎ' },
      { char: '算', syllable: 'suàn' },
    ]);
    expect(result.reading).toBe('dǎsuàn');
  });

  it('一点儿 — erhua, where r5 is a syllable AND a character', () => {
    const result = alignReading('一点儿', 'yi1 dian3 r5');
    expect(result.mode).toBe('aligned');
    expect(result.chars.map((c) => c.syllable)).toEqual(['yī', 'diǎn', 'r']);
  });

  it('AA制 — CC-CEDICT writes the Latin run as ONE token, so this falls back', () => {
    // The real entry is `AA制|AA制[AA zhi4]` — two tokens, three characters.
    // Nothing can say which of the two `A`s the token `AA` belongs to, so the
    // aligner refuses and the caller renders the word-level reading. The plan
    // lists AA制 as a hazard; this is the honest answer to it, not a
    // special case.
    const result = alignReading('AA制', 'AA zhi4');
    expect(result.mode).toBe('fallback');
    expect(result.reading).toBe('AA zhì');
    expect(result.chars.every((c) => c.syllable === undefined)).toBe(true);
  });

  it('a Latin run CC-CEDICT DOES write one token per letter aligns', () => {
    const result = alignReading('3C店', 'san1 C dian4');
    expect(result.mode).toBe('aligned');
    expect(result.chars.map((c) => c.syllable)).toEqual(['sān', 'C', 'diàn']);
  });

  it('卡拉OK — the same, mixed with hanzi', () => {
    const result = alignReading('卡拉OK', 'ka3 la1 O K');
    expect(result.mode).toBe('aligned');
    expect(result.chars.map((c) => c.syllable)).toEqual(['kǎ', 'lā', 'O', 'K']);
  });

  it('3C — a digit is a character too', () => {
    const result = alignReading('3C', 'san1 C');
    expect(result.mode).toBe('aligned');
    expect(result.chars.map((c) => c.char)).toEqual(['3', 'C']);
  });

  it('a name with · — the separator is consumed on both sides and carries no reading', () => {
    // 亚当·斯密, verbatim from data/dict.json.
    const result = alignReading('亚当·斯密', 'Ya4 dang1 · Si1 mi4');
    expect(result.mode).toBe('aligned');
    const separator = result.chars.find((c) => c.char === '·');
    expect(separator).toBeDefined();
    expect(separator?.syllable).toBeUndefined();
    expect(result.chars.filter((c) => c.syllable !== undefined)).toHaveLength(4);
  });

  it('a name whose READING omits the · the headword carries still aligns', () => {
    // 亚西尔·阿拉法特, verbatim: the two columns are not always punctuated
    // identically, so the separator is consumed when present and not insisted on.
    const result = alignReading('亚西尔·阿拉法特', 'Ya4 xi1 er3 A1 la1 fa3 te4');
    expect(result.mode).toBe('aligned');
    expect(result.chars.find((c) => c.char === '·')?.syllable).toBeUndefined();
    expect(result.chars.filter((c) => c.syllable !== undefined)).toHaveLength(7);
  });

  it('a proverb with ，— the fullwidth headword form and the halfwidth reading form agree', () => {
    // 一不做，二不休, verbatim.
    const result = alignReading('一不做，二不休', 'yi1 bu4 zuo4 , er4 bu4 xiu1');
    expect(result.mode).toBe('aligned');
    expect(result.chars.find((c) => c.char === '，')?.syllable).toBeUndefined();
    expect(result.chars.filter((c) => c.syllable !== undefined)).toHaveLength(6);
  });

  describe('xx5 — the hazard a count check cannot catch', () => {
    it('々 with reading xx5 falls back with NO annotation, not an aligned empty one', () => {
      const result = alignReading('々', 'xx5');
      // The zip would succeed: one character, one token. That is exactly why
      // `hasUnknownReading` is checked before the count.
      expect(result.mode).toBe('fallback');
      expect(result.reading).toBe('');
      expect(result.chars).toEqual([{ char: '々' }]);
      expect(result.chars.every((c) => c.syllable === undefined)).toBe(true);
    });

    it('込 — same', () => {
      const result = alignReading('込', 'xx5');
      expect(result.mode).toBe('fallback');
      expect(result.reading).toBe('');
    });

    it('a PARTIALLY unknown reading falls back too', () => {
      // One `xx5` among real syllables still means the entry cannot be aligned
      // character-by-character with any confidence.
      const result = alignReading('打々', 'da3 xx5');
      expect(result.mode).toBe('fallback');
      expect(result.reading).toBe('');
      expect(result.chars.every((c) => c.syllable === undefined)).toBe(true);
    });
  });

  it('a deliberate count mismatch falls back rather than pairing wrongly', () => {
    const tooFew = alignReading('打算去', 'da3 suan4');
    expect(tooFew.mode).toBe('fallback');
    expect(tooFew.reading).toBe('dǎsuàn');
    expect(tooFew.chars.every((c) => c.syllable === undefined)).toBe(true);

    const tooMany = alignReading('打算', 'da3 suan4 qu4');
    expect(tooMany.mode).toBe('fallback');
  });

  it('an empty or missing reading falls back with no annotation', () => {
    expect(alignReading('打算', '').mode).toBe('fallback');
    expect(alignReading('打算', '').reading).toBe('');
    expect(alignReading('打算', '   ').reading).toBe('');
  });

  it('an astral character is one character, not two surrogate halves', () => {
    // U+20BB7 is a real CC-CEDICT headword character.
    const result = alignReading('\u{20BB7}', 'nin2');
    expect(result.mode).toBe('aligned');
    expect(result.chars).toHaveLength(1);
    expect(result.chars[0].char).toBe('\u{20BB7}');
  });

  it('a multi-letter Latin token refuses rather than guessing which character it is', () => {
    // `BP机 [BP ji1]`, `4S店 [4S dian4]`, `CP值 [CP zhi2]` — the shape the whole
    // 128-entry fallback residue is made of.
    expect(alignReading('OK啦', 'OK la5').mode).toBe('fallback');
    expect(alignReading('BP机', 'BP ji1').mode).toBe('fallback');
    expect(alignReading('4S店', '4S dian4').mode).toBe('fallback');
  });

  it('isReadingPunctuation names exactly the characters the aligner skips', () => {
    for (const char of ['·', '，', ',', '、']) expect(isReadingPunctuation(char)).toBe(true);
    for (const char of ['打', 'A', '3', '。', '！']) expect(isReadingPunctuation(char)).toBe(false);
  });
});

/**
 * The property, over the real dictionary. `mode: 'aligned'` must imply that
 * every character that can carry a reading got a **non-empty** one and that no
 * syllable was dropped — non-empty is what makes the `xx5` case fail the
 * property instead of passing it.
 */
describe('over the real dictionary', () => {
  const file = resolve(dataDir(), 'dict.json');

  /**
   * **Not `it.runIf`.** This was gated on the artifact existing, and `data/` is
   * generated and gitignored — so on any tree where `pnpm data` had not run,
   * C3's headline guard silently disappeared and `pnpm test` was green without
   * it. With no CI, a test that skips itself is a rule with no enforcement
   * (CLAUDE.md). The root `test` script runs `data:ensure` now, the same way
   * `build` does, and this fails loudly rather than vanishing if it did not.
   */
  it('has the dictionary to run against', () => {
    expect(existsSync(file), `${file} is missing — run \`pnpm data\``).toBe(true);
  });

  // 248k headword/reading pairs and a full JSON parse: this is the one test in
  // the suite that is allowed to take ten seconds.
  it('aligned implies complete, and the fallback rate is recorded', { timeout: 60_000 }, () => {
    const dict = JSON.parse(readFileSync(file, 'utf8')) as DictFile;
    let aligned = 0;
    let fallback = 0;
    let unknownReading = 0;
    const examples: string[] = [];

    for (const entry of dict.entries) {
      for (const headword of [entry.simp, entry.trad]) {
        const result = alignReading(headword, entry.pinyinNum);
        if (result.mode === 'aligned') {
          aligned += 1;
          // Every character is accounted for, in order …
          expect(result.chars.map((c) => c.char).join('')).toBe(headword);
          for (const char of result.chars) {
            if (isReadingPunctuation(char.char)) {
              expect(char.syllable, `${headword} ${char.char}`).toBeUndefined();
            } else {
              // … and none of them got a blank annotation.
              expect(char.syllable, `${headword} / ${entry.pinyinNum}`).toBeTruthy();
            }
          }
        } else {
          fallback += 1;
          if (result.reading === '') unknownReading += 1;
          else if (examples.length < 20) examples.push(`${headword} [${entry.pinyinNum}]`);
        }
      }
    }

    const total = aligned + fallback;
    const rate = (fallback / total) * 100;
    process.stdout.write(
      `\nalignReading over data/dict.json — ${total.toLocaleString('en-US')} headword/reading pairs\n` +
        `  aligned:  ${aligned.toLocaleString('en-US')} (${(100 - rate).toFixed(3)}%)\n` +
        `  fallback: ${fallback.toLocaleString('en-US')} (${rate.toFixed(3)}%), of which ` +
        `${unknownReading.toLocaleString('en-US')} have no reading at all (xx5)\n` +
        `  sample:   ${examples.slice(0, 10).join('  ')}\n`,
    );

    // C3: "If that rate is above a few percent the alignment rule needs another
    // pass before C5a builds on it." The number is recorded in HANDOFF.md; this
    // is the guard that a later change does not quietly make it worse.
    expect(rate).toBeLessThan(5);
  });
});
