import { planSegments } from '@/lib/dict/segment';
import { markSyllable, toMarked } from '@/lib/dict/pinyin';

import { applySandhi, tonesOf } from './sandhi';
import type { Cue, Reading, Word, ZhLine } from './types';

type CompactReading = [pinyinNum: string, glosses: string, hsk: number, proper: 0 | 1];

/** The shape `scripts/build-dict.ts` writes. */
export interface CompactDict {
  version: string;
  stats: { logTotal: number; maxLen: number };
  words: Record<string, [number, CompactReading[]]>;
}

function expand([pinyinNum, glosses, hsk, proper]: CompactReading): Reading {
  return {
    pinyinNum,
    pinyin: toMarked(pinyinNum),
    glosses: glosses.split('/'),
    ...(hsk ? { hsk } : {}),
    ...(proper ? { properNoun: true } : {}),
  };
}

/**
 * The extension's dictionary: Tangram's segmenter (jieba's max-probability DP
 * over CC-CEDICT, no HMM) plus lookups, over the compact simplified file.
 */
export class Dictionary {
  constructor(private readonly data: CompactDict) {}

  get version(): string {
    return this.data.version;
  }

  lookup(word: string): Reading[] {
    return (this.data.words[word]?.[1] ?? []).map(expand);
  }

  /** Segment one line, attach readings, and apply spoken tone changes across it. */
  segmentLine(text: string): Word[] {
    const plan = planSegments(text, {
      script: 'simp',
      stats: this.data.stats,
      freqOf: (word) => this.data.words[word]?.[0],
    });
    const words: Word[] = plan.tokens.map((token) =>
      token.kind === 'word'
        ? { text: token.text, kind: 'word', readings: this.lookup(token.text) }
        : { text: token.text, kind: 'text', readings: [] },
    );
    const spoken = applySandhi(
      words.map((word) => ({ text: word.text, pinyinNum: word.readings[0]?.pinyinNum })),
    );
    return words.map((word, i) => {
      const pinyinNum = spoken[i];
      if (!pinyinNum) return word;
      return {
        ...word,
        pinyin: toMarked(pinyinNum),
        syllables: pinyinNum.trim().split(/\s+/).map(markSyllable),
        tones: tonesOf(pinyinNum),
      };
    });
  }

  annotate(cues: readonly Cue[]): ZhLine[] {
    return cues.map((cue) => ({ ...cue, words: this.segmentLine(cue.text) }));
  }
}
