// @vitest-environment node
/**
 * The i+1 filter (PLAN.md §4, Phase 6 item 1) — "the prompt asks, the filter
 * enforces", stated as cases.
 *
 * These run against the real dictionary, like the rest of the grounding tests:
 * the claim being made is about Chinese words, so a fixture that could agree
 * with a bug is not evidence.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  EXAMPLES_SHOWN,
  groundExamples,
  keepSentence,
  knownHeadwords,
  type ExampleSentence,
} from '@/lib/ai/examples';
import { renderPhrase, entryLookup } from '@/lib/ai/ground';
import type { ParsedExampleSentences } from '@/lib/ai/provider';
import type { CardRow } from '@/lib/db/schema';
import { KNOWN_STABILITY_DAYS } from '@/lib/srs/states';
import type { Entry } from '@/lib/types';
import { requireDictData } from '../dict/data-required';
import { entryFor, groundContext } from './helpers';

beforeAll(requireDictData);

/** 开始 is the target throughout: a band-2 word with a plain first gloss. */
function target(): Entry {
  return entryFor('开始');
}

function sentences(...rows: { tokens: ({ entryId: string } | { text: string })[] }[]): ParsedExampleSentences {
  return {
    sentences: rows.map((row) => ({ tokens: row.tokens, en: 'A sentence for the card back.' })),
  };
}

describe('the filter', () => {
  it('keeps a sentence that cites only known words plus the target', () => {
    const wo = entryFor('我');
    const entry = target();
    const kept = groundExamples(
      sentences({ tokens: [{ entryId: wo.id }, { entryId: entry.id }] }),
      groundContext([entry, wo]),
      { targetId: entry.id, allowed: new Set([wo.id]) },
    );

    expect(kept).toHaveLength(1);
    // And what it renders is the dictionary's hanzi and the dictionary's
    // reading, because grounding did the rendering.
    const rendered = renderPhrase(kept[0], entryLookup([entry, wo]));
    expect(rendered.zh).toBe(`${wo.simp}${entry.simp}`);
    expect(rendered.pinyin).toContain(entry.pinyinMarked);
  });

  it('drops a sentence citing an entry the learner does not know', () => {
    const entry = target();
    const wo = entryFor('我');
    // 图书馆 was retrieved — so grounding is perfectly happy with it — and is
    // not in the known set. This is the case the whole feature exists for, and
    // the one grounding alone would let through.
    const stranger = entryFor('图书馆');

    const kept = groundExamples(
      sentences({ tokens: [{ entryId: wo.id }, { entryId: stranger.id }, { entryId: entry.id }] }),
      groundContext([entry, wo, stranger]),
      { targetId: entry.id, allowed: new Set([wo.id]) },
    );

    expect(kept).toEqual([]);
  });

  it('drops the whole sentence for one uncited {text} token, never trims it', () => {
    const entry = target();
    const wo = entryFor('我');
    const kept = groundExamples(
      sentences({ tokens: [{ entryId: wo.id }, { text: '天天' }, { entryId: entry.id }] }),
      groundContext([entry, wo]),
      { targetId: entry.id, allowed: new Set([wo.id]) },
    );

    expect(kept).toEqual([]);
  });

  it('drops a sentence that never mentions the target', () => {
    const entry = target();
    const wo = entryFor('我');
    const shi = entryFor('是');
    const kept = groundExamples(
      sentences({ tokens: [{ entryId: wo.id }, { entryId: shi.id }] }),
      groundContext([entry, wo, shi]),
      { targetId: entry.id, allowed: new Set([wo.id, shi.id]) },
    );

    expect(kept).toEqual([]);
  });

  it('shows at most two, whatever the provider returned', () => {
    const entry = target();
    const wo = entryFor('我');
    const shi = entryFor('是');
    const one = { tokens: [{ entryId: wo.id }, { entryId: entry.id }] };
    const two = { tokens: [{ entryId: shi.id }, { entryId: entry.id }] };
    const kept = groundExamples(
      sentences(one, two, one, two),
      groundContext([entry, wo, shi]),
      { targetId: entry.id, allowed: new Set([wo.id, shi.id]) },
    );

    expect(EXAMPLES_SHOWN).toBe(2);
    expect(kept).toHaveLength(EXAMPLES_SHOWN);
  });

  it('drops a sentence grounding could not verify, without re-deciding why', () => {
    const entry = target();
    // The flag is grounding's verdict; `keepSentence` only has to respect it.
    const flagged = {
      tokens: [{ entryId: entry.id }],
      en: 'x',
      register: '',
      unverified: true,
    } satisfies ExampleSentence;
    expect(keepSentence(flagged, { targetId: entry.id, allowed: new Set() })).toBe(false);
    expect(keepSentence({ ...flagged, unverified: false }, { targetId: entry.id, allowed: new Set() })).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 8);

function card(entry: Entry, fsrs: Partial<CardRow['fsrs']> = {}): CardRow {
  return {
    id: `card-${entry.id}`,
    wordId: `word-${entry.id}`,
    entryId: entry.id,
    kind: 'word',
    direction: 'recognition',
    snapshot: {
      simp: entry.simp,
      trad: entry.trad,
      pinyinMarked: entry.pinyinMarked,
      pinyinNum: entry.pinyinNum,
      glosses: entry.glosses,
      classifiers: entry.classifiers,
      ...(entry.hskBand === undefined ? {} : { hskBand: entry.hskBand }),
      ...(entry.freqRank === undefined ? {} : { freqRank: entry.freqRank }),
      dictVersion: 'test',
    },
    fsrs: {
      state: 0,
      due: NOW,
      stability: 0,
      difficulty: 5,
      reps: 0,
      lapses: 0,
      scheduled_days: 0,
      learning_steps: 0,
      ...fsrs,
    },
    due: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

describe('the known set', () => {
  const settings = { knownBand: 2 as const };

  it('is the reader’s own rule: a card still being learned is not a known word', () => {
    // 图书馆 is band 3, so nothing but the card's own state can make it known.
    const learning = entryFor('图书馆');
    const consolidated = entryFor('医院');

    const words = knownHeadwords({
      settings,
      cards: [
        card(learning, { state: 2, stability: KNOWN_STABILITY_DAYS - 1 }),
        card(consolidated, { state: 2, stability: KNOWN_STABILITY_DAYS + 1 }),
      ],
      known: [],
    });

    expect(words).toContain(consolidated.simp);
    expect(words).not.toContain(learning.simp);
  });

  it('counts a declared known word that never had a card', () => {
    const declared = entryFor('图书馆');
    expect(knownHeadwords({ settings, cards: [], known: [declared.id] })).toEqual([declared.simp]);
  });

  it('counts a band the learner is past, and a new card cannot undo it', () => {
    // 我 is band 1 and `knownBand` is 2, so it is known even with a New card on
    // it — `wordState` puts the card first, and a New card reads as learning.
    const banded = entryFor('是');
    expect(knownHeadwords({ settings, cards: [], known: [banded.id] })).toContain(banded.simp);
    expect(knownHeadwords({ settings, cards: [card(banded)], known: [] })).toEqual([]);
  });

  it('is frequency-ordered and capped, so the same learner keys the same way twice', () => {
    const common = entryFor('我');
    const rarer = entryFor('图书馆');
    const cards = [
      card(rarer, { state: 2, stability: KNOWN_STABILITY_DAYS + 1 }),
      card(common, { state: 2, stability: KNOWN_STABILITY_DAYS + 1 }),
    ];
    expect(knownHeadwords({ settings, cards, known: [] })).toEqual([common.simp, rarer.simp]);
    expect(knownHeadwords({ settings, cards, known: [] }, 1)).toEqual([common.simp]);
  });
});
