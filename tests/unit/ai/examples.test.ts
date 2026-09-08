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
  filterCachedSentences,
  groundExamples,
  keepSentence,
  knownEntryFilter,
  knownHeadwords,
  knownSet,
  type ExampleSentence,
} from '@/lib/ai/examples';
import { MAX_PHRASE_TOKENS, renderPhrase, entryLookup } from '@/lib/ai/ground';
import type { ParsedExampleSentences } from '@/lib/ai/provider';
import type { CardRow } from '@/lib/db/schema';
import { KNOWN_STABILITY_DAYS } from '@/lib/srs/states';
import type { Entry } from '@/lib/types';
import { requireDictData } from '../dict/data-required';
import { entryFor, groundContext, readingOf } from './helpers';

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

  it('drops a sentence over the token cap instead of trimming it to fit', () => {
    // A trimmed sentence is the worst of both: the learner is shown part of a
    // sentence with the model's English for the *whole* one under it, and every
    // rule below the cut stops applying. `ground` drops it instead.
    //
    // The filler cycles through four words rather than repeating one, because a
    // character that comes back within two positions is `hasNearRepeat`, and
    // that is a different reason to drop a phrase.
    const entry = target();
    const cycle = ['我', '你', '他', '是'].map(entryFor);
    const allowed = new Set(cycle.map((word) => word.id));
    const context = groundContext([entry, ...cycle]);
    const filler = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ entryId: cycle[index % cycle.length].id }));

    const atCap = groundExamples(
      sentences({ tokens: [...filler(MAX_PHRASE_TOKENS - 1), { entryId: entry.id }] }),
      context,
      { targetId: entry.id, allowed },
    );
    expect(atCap).toHaveLength(1);
    expect(atCap[0].tokens).toHaveLength(MAX_PHRASE_TOKENS);

    const overCap = groundExamples(
      sentences({ tokens: [...filler(MAX_PHRASE_TOKENS), { entryId: entry.id }] }),
      context,
      { targetId: entry.id, allowed },
    );
    expect(overCap).toEqual([]);
  });

  it('cannot have an unknown word or an invented one trimmed off the end', () => {
    // Both used to hide past the cap: the citation the learner does not know,
    // and the model's own characters. Trimming made the sentence *pass* the
    // filter, with every surviving token cited and allowed.
    const entry = target();
    const cycle = ['我', '你', '他', '是'].map(entryFor);
    const stranger = entryFor('附近');
    const allowed = new Set(cycle.map((word) => word.id));
    const filler = Array.from({ length: MAX_PHRASE_TOKENS - 1 }, (_, index) => ({
      entryId: cycle[index % cycle.length].id,
    }));

    for (const tail of [{ entryId: stranger.id }, { text: '绝绝子' }]) {
      const kept = groundExamples(
        sentences({ tokens: [{ entryId: entry.id }, ...filler, tail] }),
        groundContext([entry, ...cycle, stranger]),
        { targetId: entry.id, allowed },
      );
      expect(kept).toEqual([]);
    }
  });

  it('drops a sentence citing another reading of a word the learner knows', () => {
    // The learner knows 看 kàn "to see" (HSK 1). 看 kān "to look after" is HSK 6
    // — the same two characters, a different word, a different tone. A whitelist
    // built from headwords lets it through; one built from ids does not.
    const entry = target();
    const kan = readingOf('看', 'kan4');
    const kanOther = readingOf('看', 'kan1');
    expect(kan.simp).toBe(kanOther.simp);

    const kept = groundExamples(
      sentences({ tokens: [{ entryId: kanOther.id }, { entryId: entry.id }] }),
      groundContext([entry, kan, kanOther]),
      { targetId: entry.id, allowed: new Set([kan.id]) },
    );
    expect(kept).toEqual([]);
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
    // Both are band 1 and `knownBand` is 2, and it makes no difference: a card
    // outranks the band assumption (`wordState`), so the only thing that
    // separates these two is how far along the card is.
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
    const declared = entryFor('附近');
    expect(knownHeadwords({ settings, cards: [], known: [declared.id] })).toEqual([declared.simp]);
  });

  it('sends the band assumption as a band, because only the server has the words', () => {
    // "Assume known through HSK 2" names words the learner has no card and no
    // `known_words` row for, so it cannot be a list of headwords here: the
    // browser has no dictionary. It travels as the band itself.
    const set = knownSet({ settings, cards: [], known: [] });
    expect(set.headwords).toEqual([]);
    expect(set.ids).toEqual([]);
    expect(set.knownBand).toBe(2);
    expect(set.excludeIds).toEqual([]);
  });

  it('carries the exceptions to the band: a card outranks it, as everywhere else', () => {
    // 是 is band 1 and `knownBand` is 2, so the band would call it known — but a
    // New card on it means the learner is being taught it right now, and
    // `wordState` puts the card first. The id travels so the server's band
    // expansion cannot promote it back.
    const banded = entryFor('是');
    const set = knownSet({ settings, cards: [card(banded)], known: [] });
    expect(set.headwords).toEqual([]);
    expect(set.ids).toEqual([]);
    expect(set.excludeIds).toEqual([banded.id]);

    // Declared known, and it is known: the card is gone from the exceptions.
    const declared = knownSet({ settings, cards: [card(banded)], known: [banded.id] });
    expect(declared.ids).toEqual([banded.id]);
    expect(declared.excludeIds).toEqual([]);
  });

  it('is a set of entry ids, so the other reading of a known word is not in it', () => {
    const kan = readingOf('看', 'kan4');
    const kanOther = readingOf('看', 'kan1');
    const set = knownSet({ settings, cards: [], known: [kan.id] });

    expect(set.ids).toEqual([kan.id]);
    expect(set.ids).not.toContain(kanOther.id);
    // The headword is the same characters for both, which is exactly why the
    // filter is not allowed to run on headwords.
    expect(set.headwords).toEqual([kan.simp]);
  });

  it('answers "does the learner know this entry" the way the reader would', () => {
    const kan = readingOf('看', 'kan4');
    const kanOther = readingOf('看', 'kan1');
    const banded = entryFor('是');
    const stranger = entryFor('附近');

    const knows = knownEntryFilter(knownSet({ settings, cards: [card(banded)], known: [kan.id] }));
    expect(knows(kan)).toBe(true);
    // Same characters, never met: 看 kān is band 6.
    expect(knows(kanOther)).toBe(false);
    // Band 1, but there is a card on it being learned.
    expect(knows(banded)).toBe(false);
    // Band 4, no card, never declared.
    expect(knows(stranger)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the cached row, re-checked before it is drawn', () => {
  const settings = { knownBand: 2 as const };
  const entry = target();

  function cached(...ids: string[]): ExampleSentence[] {
    return [
      {
        tokens: ids.map((entryId) => ({ entryId })),
        en: 'A sentence written when the known set was bigger.',
        register: '',
        unverified: false,
      },
    ];
  }

  it('drops a sentence built from a word the learner has since un-marked', () => {
    // The everyday case, and the reason the re-check exists: an explicit Add
    // un-marks the word it was built from (`lib/lists/looked-up.ts`) and adds a
    // card, so a warm row can outlive the promise it was written under. 附近 is
    // band 4, past the assumption, so the declaration is all it had.
    const stranger = entryFor('附近');
    const sentence = cached(stranger.id, entry.id);
    const entries = [stranger, entry];

    const known = knownSet({ settings, cards: [], known: [stranger.id] });
    expect(filterCachedSentences(sentence, { targetId: entry.id, entries, set: known })).toEqual(
      sentence,
    );

    const after = knownSet({ settings, cards: [card(stranger)], known: [] });
    expect(filterCachedSentences(sentence, { targetId: entry.id, entries, set: after })).toEqual([]);
  });

  it('drops a sentence whose citation the dictionary no longer resolves', () => {
    // A content-derived id retires when CC-CEDICT respells a reading. The token
    // then renders as `?` with a `—` under it, mid-sentence, under a heading
    // that says every word here is one you know.
    const wo = entryFor('我');
    const sentence = cached(wo.id, entry.id);
    const known = knownSet({ settings, cards: [], known: [wo.id] });

    expect(
      filterCachedSentences(sentence, { targetId: entry.id, entries: [wo, entry], set: known }),
    ).toEqual(sentence);
    // The same row, one entry short of resolvable.
    expect(
      filterCachedSentences(sentence, { targetId: entry.id, entries: [entry], set: known }),
    ).toEqual([]);
  });

  it('keeps a sentence whose words the band assumption covers', () => {
    const wo = entryFor('我');
    expect(wo.hskBand).toBeLessThanOrEqual(2);
    const sentence = cached(wo.id, entry.id);
    const known = knownSet({ settings, cards: [], known: [] });

    expect(
      filterCachedSentences(sentence, { targetId: entry.id, entries: [wo, entry], set: known }),
    ).toEqual(sentence);
  });

  it('drops a cached sentence citing the other reading of a known headword', () => {
    const kan = readingOf('看', 'kan4');
    const kanOther = readingOf('看', 'kan1');
    // Out of the band's reach, so the declared id is the only thing that counts.
    expect(kanOther.hskBand === undefined || kanOther.hskBand > 2).toBe(true);
    const sentence = cached(kanOther.id, entry.id);
    const known = knownSet({ settings, cards: [], known: [kan.id] });

    expect(
      filterCachedSentences(sentence, {
        targetId: entry.id,
        entries: [kanOther, entry],
        set: known,
      }),
    ).toEqual([]);
  });

  it('is frequency-ordered and capped, so the same learner keys the same way twice', () => {
    const common = entryFor('我');
    const rarer = entryFor('附近');
    const cards = [
      card(rarer, { state: 2, stability: KNOWN_STABILITY_DAYS + 1 }),
      card(common, { state: 2, stability: KNOWN_STABILITY_DAYS + 1 }),
    ];
    expect(knownHeadwords({ settings, cards, known: [] })).toEqual([common.simp, rarer.simp]);
    expect(knownHeadwords({ settings, cards, known: [] }, 1)).toEqual([common.simp]);
  });
});
