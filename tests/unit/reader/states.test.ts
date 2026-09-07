import { describe, expect, it } from 'vitest';

import { createDexieRepository, TangramDb } from '@/lib/db/dexie';
import type { Repository } from '@/lib/db/repository';
import type { FsrsCardState } from '@/lib/db/schema';
import type { EntrySource } from '@/lib/lists/entry-source';
import {
  buildReaderIndex,
  emptyReaderIndex,
  entryState,
  readReaderIndex,
  tokenState,
  tokenStates,
} from '@/lib/reader/states';
import { KNOWN_STABILITY_DAYS } from '@/lib/srs/states';
import type { Entry, EntryId, HskBand, Token } from '@/lib/types';

/**
 * PLAN.md §3.5 and §3.3. The thresholds themselves belong to
 * `tests/unit/srs/states.test.ts`; what is tested here is the reader's pass over
 * a whole text — one index, every token answered from it, and the rule that a
 * token wears the strongest state of its readings.
 */

let made = 0;
function entry(overrides: Partial<Entry> = {}): Entry {
  made += 1;
  const simp = overrides.simp ?? `词${made}`;
  return {
    id: overrides.id ?? `${simp}|${simp}[ci2${made}]`,
    simp,
    trad: simp,
    pinyinNum: 'ci2',
    pinyinMarked: 'cí',
    glosses: ['a test word'],
    classifiers: [],
    properNoun: false,
    isVariant: false,
    surname: false,
    ...overrides,
  };
}

function word(text: string, entryIds: EntryId[]): Token {
  return { text, start: 0, end: text.length, kind: 'word', entryIds, via: entryIds.length ? 'entry' : 'fallback' };
}

function punctuation(text: string): Token {
  return { text, start: 0, end: text.length, kind: 'text', entryIds: [], via: 'fallback' };
}

function fsrs(overrides: Partial<FsrsCardState> = {}): FsrsCardState {
  return {
    state: 0,
    due: 0,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    scheduled_days: 0,
    learning_steps: 0,
    ...overrides,
  };
}

const LE: EntryId = '了|了[le5]';
const LIAO: EntryId = '了|了[liao3]';
const DASUAN: EntryId = '打算|打算[da3 suan4]';

describe('the reader colouring pass', () => {
  it('a word with no card, no known row and no band is new', () => {
    const index = buildReaderIndex({ cards: [], known: [], knownBand: 2 });
    expect(entryState(DASUAN, index)).toBe('new');
  });

  it('a banded word at or below knownBand is known — knownBand 2 covers HSK 1–2', () => {
    const index = buildReaderIndex({
      cards: [],
      known: [],
      bands: [
        ['一|一[yi1]', 1],
        [DASUAN, 2],
      ],
      knownBand: 2,
    });
    expect(entryState('一|一[yi1]', index)).toBe('known');
    expect(entryState(DASUAN, index)).toBe('known');
    // Band 3 is not in the map at all: the reader only pulls the bands the
    // setting can act on, and everything else answers from cards alone.
    expect(entryState('继续|继续[ji4 xu4]', index)).toBe('new');
  });

  it('a card outranks the band assumption', () => {
    const index = buildReaderIndex({
      cards: [{ entryId: DASUAN, fsrs: fsrs({ state: 0 }) }],
      known: [],
      bands: [[DASUAN, 2]],
      knownBand: 2,
    });
    // §3.3: the band is a guess about words never touched. A card means touched.
    expect(entryState(DASUAN, index)).toBe('learning');
  });

  it('a declared known word outranks its own card', () => {
    const index = buildReaderIndex({
      cards: [{ entryId: DASUAN, fsrs: fsrs({ state: 0 }) }],
      known: [DASUAN],
      knownBand: 1,
    });
    expect(entryState(DASUAN, index)).toBe('known');
  });

  it('a consolidated Review card is known, a fresh one is learning', () => {
    const index = buildReaderIndex({
      cards: [
        { entryId: DASUAN, fsrs: fsrs({ state: 2, stability: KNOWN_STABILITY_DAYS }) },
        { entryId: LE, fsrs: fsrs({ state: 2, stability: KNOWN_STABILITY_DAYS - 1 }) },
      ],
      known: [],
      knownBand: 1,
    });
    expect(entryState(DASUAN, index)).toBe('known');
    expect(entryState(LE, index)).toBe('learning');
  });

  it('two cards for one entry answer with the further-along one', () => {
    const index = buildReaderIndex({
      cards: [
        { entryId: DASUAN, fsrs: fsrs({ state: 0 }) },
        { entryId: DASUAN, fsrs: fsrs({ state: 2, stability: 400 }) },
      ],
      known: [],
      knownBand: 1,
    });
    expect(entryState(DASUAN, index)).toBe('known');
  });

  it('a token wears the strongest state of its readings', () => {
    const index = buildReaderIndex({
      cards: [{ entryId: LE, fsrs: fsrs({ state: 0 }) }],
      known: [],
      knownBand: 1,
    });
    // 了 le is a card, 了 liǎo is untouched: the learner has met the word.
    expect(tokenState(word('了', [LE, LIAO]), index)).toBe('learning');
    expect(tokenState(word('了', [LIAO]), index)).toBe('new');
  });

  it('text tokens have no state at all, and word tokens with no entry are new', () => {
    const index = emptyReaderIndex(2);
    expect(tokenState(punctuation('？'), index)).toBeUndefined();
    expect(tokenState(punctuation(' '), index)).toBeUndefined();
    // `via: 'fallback'` — a name or a rare character the dictionary has no
    // headword for. It is still a word the learner has not met.
    expect(tokenState(word('峣', []), index)).toBe('new');
  });

  it('colours a whole token list in one pass, in order', () => {
    const index = buildReaderIndex({
      cards: [{ entryId: DASUAN, fsrs: fsrs({ state: 0 }) }],
      known: [],
      bands: [['我|我[wo3]', 1]],
      knownBand: 2,
    });
    const tokens = [
      word('我', ['我|我[wo3]']),
      word('打算', [DASUAN]),
      word('明天', ['明天|明天[ming2 tian1]']),
      punctuation('。'),
    ];
    expect(tokenStates(tokens, index)).toEqual(['known', 'learning', 'new', undefined]);
  });
});

describe('readReaderIndex', () => {
  function source(bands: Partial<Record<HskBand, Entry[]>>): EntrySource & { calls: HskBand[] } {
    const calls: HskBand[] = [];
    return {
      calls,
      async band(band) {
        calls.push(band);
        return bands[band] ?? [];
      },
      async entries() {
        return [];
      },
      async search() {
        return [];
      },
    };
  }

  function fresh(): { db: TangramDb; repo: Repository } {
    const db = new TangramDb(`tangram-reader-${Date.now()}-${made++}`);
    return { db, repo: createDexieRepository(db) };
  }

  it('reads the cards, the known rows and only the bands at or below knownBand', async () => {
    const { db, repo } = fresh();
    try {
      const one = entry({ id: '一|一[yi1]', simp: '一', hskBand: 1 });
      const two = entry({ id: '二|二[er4]', simp: '二', hskBand: 2 });
      const three = entry({ id: '三|三[san1]', simp: '三', hskBand: 3 });
      const banded = source({ 1: [one], 2: [two], 3: [three] });

      await repo.setSettings({ knownBand: 2 });
      await repo.addCardFromEntry(entry({ id: DASUAN, simp: '打算' }));
      await repo.markKnown(['四|四[si4]']);

      const index = await readReaderIndex(repo, banded);

      expect(banded.calls).toEqual([1, 2]);
      expect(index.knownBand).toBe(2);
      expect(index.bands.get(one.id)).toBe(1);
      expect(index.bands.has(three.id)).toBe(false);
      expect(index.cards.has(DASUAN)).toBe(true);
      expect(index.known.has('四|四[si4]')).toBe(true);

      expect(tokenStates([word('一', [one.id]), word('三', [three.id]), word('打算', [DASUAN])], index)).toEqual([
        'known',
        'new',
        'learning',
      ]);
    } finally {
      db.close();
    }
  });

  it('costs one read per table however long the text is', async () => {
    const { db, repo } = fresh();
    try {
      let reads = 0;
      const counted: Repository = new Proxy(repo, {
        get(target, key: keyof Repository) {
          if (key === 'allCards' || key === 'knownEntryIds' || key === 'getSettings') reads += 1;
          return target[key];
        },
      }) as Repository;

      const index = await readReaderIndex(counted, source({}));
      const tokens = Array.from({ length: 2000 }, (_, i) => word('字', [`x${i}`]));
      expect(tokenStates(tokens, index)).toHaveLength(2000);
      expect(reads).toBe(3);
    } finally {
      db.close();
    }
  });
});
