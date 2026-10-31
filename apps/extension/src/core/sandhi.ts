/**
 * Tone changes as they are spoken, applied across a whole line so a change can
 * cross a word boundary (不 + 是 are two words; 不是 is said bú shì).
 *
 * Only 一 and 不 are rewritten. Third-tone sandhi (你好 → ní hǎo) is left as
 * written, which is also what textbooks and Pleco do: the marked tone is the
 * one a learner looks up, and the spoken change is regular enough to teach as
 * a rule rather than hide in the data.
 */

const NUMERALS = new Set('零〇一二三四五六七八九十百千万亿两0123456789');

interface Syllable {
  char: string;
  /** Index into `words`, and into that word's syllables. */
  word: number;
  index: number;
  tone: number;
  lastOfWord: boolean;
}

export interface SandhiWord {
  text: string;
  /** Numbered pinyin, one syllable per character, e.g. `bu4 shi4`. */
  pinyinNum?: string;
}

/** Returns each word's numbered pinyin with the spoken tones; `undefined` stays `undefined`. */
export function applySandhi(words: readonly SandhiWord[]): (string | undefined)[] {
  const tokens = words.map((word) => word.pinyinNum?.trim().split(/\s+/));
  const syllables: (Syllable | null)[] = [];
  words.forEach((word, w) => {
    const parts = tokens[w];
    const chars = [...word.text];
    // Only a reading with exactly one syllable per character can be lined up.
    if (!parts || parts.length !== chars.length) {
      syllables.push(null);
      return;
    }
    parts.forEach((part, i) => {
      const tone = Number(part.at(-1));
      syllables.push({
        char: chars[i]!,
        word: w,
        index: i,
        tone: Number.isInteger(tone) ? tone : 0,
        lastOfWord: i === parts.length - 1,
      });
    });
  });

  const setTone = (s: Syllable, tone: number): void => {
    const parts = tokens[s.word]!;
    parts[s.index] = parts[s.index]!.replace(/[1-5]$/, String(tone));
  };

  for (let i = 0; i < syllables.length; i += 1) {
    const s = syllables[i];
    const next = syllables[i + 1];
    if (!s || !next || next.tone === 0) continue;
    if (s.char === '不' && s.tone === 4 && next.tone === 4) {
      setTone(s, 2);
    } else if (s.char === '一' && s.tone === 1) {
      const prev = syllables[i - 1];
      // Ordinals and numbers keep yī: 第一, 十一, 一二三; so does 一 ending a
      // word like 统一 or 唯一 — the change happens only when 一 leads into
      // what it counts or modifies.
      if (prev && (prev.char === '第' || NUMERALS.has(prev.char))) continue;
      if (NUMERALS.has(next.char)) continue;
      if (s.lastOfWord && [...words[s.word]!.text].length > 1) continue;
      setTone(s, next.tone === 4 || next.tone === 5 ? 2 : 4);
    }
  }
  return tokens.map((parts) => parts?.join(' '));
}

/** Tone number per syllable of a numbered reading; 5 for neutral, 0 for a non-syllable. */
export function tonesOf(pinyinNum: string): number[] {
  return pinyinNum
    .trim()
    .split(/\s+/)
    .map((part) => {
      const tone = Number(part.at(-1));
      return Number.isInteger(tone) && tone >= 1 && tone <= 5 ? tone : 0;
    });
}
