/**
 * The demo seed's invariants (PLAN.md §4 P3): what the morning demo has to find
 * when it opens the app.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { isPhraseSnapshot } from '@/lib/db/schema';
import {
  DEMO_PARAGRAPH,
  DEMO_TEXT_TITLE,
  demoAskCacheKey,
  loadDemo,
  resetAll,
  sentenceAround,
} from '@/lib/dev/seed';
import { sha1Hex } from '@/lib/dev/sha1';
import { todayKey } from '@/lib/srs/day';
import { wordState } from '@/lib/srs/states';
import { requireDictData } from '../dict/data-required';
import { dictEntrySource, freshRepository } from './helpers';

const NOW = new Date(2026, 8, 7, 12).getTime();

let close: (() => void) | undefined;

beforeAll(() => {
  requireDictData();
});

afterEach(() => {
  close?.();
  close = undefined;
});

function setup() {
  const { db, repo } = freshRepository();
  close = () => db.close();
  return repo;
}

describe('loadDemo', () => {
  it('builds a learner: known bands, provenance, history, a text and a warm cache', async () => {
    const repo = setup();
    const summary = await loadDemo({ repo, now: NOW, source: dictEntrySource() });

    // HSK 1–2 known, and enough of them that the profile has something to say.
    expect(summary.knownCount).toBeGreaterThan(1000);

    // ~8 cards, and every context source the app can produce is represented.
    expect(summary.cards.length).toBeGreaterThanOrEqual(8);
    const sources = new Set(summary.cards.map((card) => card.context?.source));
    for (const source of ['lookup', 'ask', 'reader', 'list']) expect(sources).toContain(source);

    const lookup = summary.cards.find((card) => card.context?.source === 'lookup');
    expect(lookup?.context?.query).toBeTruthy();
    const ask = summary.cards.find((card) => card.context?.source === 'ask');
    expect(ask?.context?.question).toBeTruthy();

    const reader = summary.cards.find((card) => card.context?.source === 'reader');
    const context = reader?.context;
    expect(context?.sentence).toBeTruthy();
    expect(context?.offset).toBeGreaterThanOrEqual(0);
    expect(context?.length).toBeGreaterThan(0);
    // The highlight must point at the card's own word inside its own sentence.
    const snapshot = reader && !isPhraseSnapshot(reader.snapshot) ? reader.snapshot : undefined;
    expect(context?.sentence?.slice(context.offset ?? 0, (context?.offset ?? 0) + (context?.length ?? 0))).toBe(
      snapshot?.simp,
    );
    expect(DEMO_PARAGRAPH).toContain(context?.sentence ?? '');

    // Three cards waiting and two mid-learning, per the phase's acceptance line.
    expect(summary.dueCount).toBeGreaterThanOrEqual(3);
    expect(summary.learningCount).toBeGreaterThanOrEqual(2);
    expect(summary.newCount).toBeGreaterThanOrEqual(1);

    // A due card carries a sentence, so /review has provenance to show.
    const due = await repo.listDue(NOW);
    expect(due.some((card) => card.context?.sentence)).toBe(true);

    // The history is real review rows, not a hand-written FSRS state.
    const reviewed = due[0];
    expect(reviewed.fsrs.reps).toBeGreaterThan(0);

    const texts = await repo.texts();
    expect(texts).toHaveLength(1);
    expect(texts[0].title).toBe(DEMO_TEXT_TITLE);
    expect(texts[0].body.length).toBeGreaterThan(120);
    expect(texts[0].body.length).toBeLessThan(200);

    expect(summary.askCacheKeys).toHaveLength(2);
    for (const key of summary.askCacheKeys) {
      expect(key).toMatch(/^[0-9a-f]{40}$/);
      const row = await repo.askCache.get(key);
      expect(row).toBeDefined();
      const response = row?.response as { matches: { entryId: string }[]; interpretation: string };
      expect(response.interpretation).not.toMatch(/[一-鿿]/);
      for (const match of response.matches) expect(match.entryId).toContain('|');
    }
  });

  it('records the real dictionary snapshot and charges the day for its list cards', async () => {
    const repo = setup();
    const summary = await loadDemo({ repo, now: NOW, source: dictEntrySource() });

    // Every card names the snapshot it was cut from: the source has fetched the
    // bands and the entries by the time the cards are written, so 'unknown' is a
    // dropped argument, not a fact about the data.
    for (const card of summary.cards) {
      expect(card.snapshot.dictVersion).toMatch(/\d/);
      expect(card.snapshot.dictVersion).not.toBe('unknown');
      const word = card.entryId ? await repo.wordByEntryId(card.entryId) : undefined;
      expect(word?.snapshot.dictVersion).toMatch(/\d/);
    }

    // The seed's `list`/`seed` cards are introductions like any other and spend
    // today's allowance, so grading them cannot hand the slots back.
    const nonExplicit = summary.cards.filter(
      (card) => !['lookup', 'ask', 'reader'].includes(card.context?.source ?? ''),
    );
    expect(nonExplicit.length).toBeGreaterThan(0);
    expect(summary.settings.introduced[todayKey(NOW, summary.settings.dayRollover)]).toBe(
      nonExplicit.length,
    );

    // A card cannot have been reviewed before it was added.
    const reviewed = summary.cards.filter((card) => card.fsrs.reps > 0);
    expect(reviewed.length).toBeGreaterThan(0);
    for (const card of reviewed) {
      expect(card.fsrs.last_review).toBeGreaterThan(card.context?.addedAt ?? 0);
    }
  });

  it('puts the explicit adds in the Looked up list and nothing else', async () => {
    const repo = setup();
    const summary = await loadDemo({ repo, now: NOW, source: dictEntrySource() });
    const lists = await repo.lists();
    const lookedUp = lists.find((list) => list.kind === 'looked-up');
    expect(lookedUp).toBeDefined();
    const members = await repo.listMembers(lookedUp!.id);
    const explicit = summary.cards.filter((card) =>
      ['lookup', 'ask', 'reader'].includes(card.context?.source ?? ''),
    );
    expect(members).toHaveLength(explicit.length);
    expect(new Set(members.map((row) => row.entryId))).toEqual(
      new Set(explicit.map((card) => card.entryId)),
    );
  });

  it('is idempotent: loading twice leaves one demo, not two', async () => {
    const repo = setup();
    const source = dictEntrySource();
    const first = await loadDemo({ repo, now: NOW, source });
    const second = await loadDemo({ repo, now: NOW, source });
    expect(second.cards.length).toBe(first.cards.length);
    expect((await repo.texts()).length).toBe(1);
  });

  it('keeps the studied words out of the known set, so the queue still wants them', async () => {
    const repo = setup();
    const summary = await loadDemo({ repo, now: NOW, source: dictEntrySource() });
    const known = new Set(await repo.knownEntryIds());
    const states = summary.cards.map((card) => {
      // A demo card is never *declared* known: the bands the seed marks known and
      // the band its cards come from are disjoint on purpose.
      expect(known.has(card.entryId ?? '')).toBe(false);
      const snapshot = isPhraseSnapshot(card.snapshot) ? undefined : card.snapshot;
      return wordState({
        card: card.fsrs,
        hskBand: snapshot?.hskBand,
        knownBand: summary.settings.knownBand,
      });
    });
    // `wordState` calls an unstarted card "learning" — it has been met. The
    // untouched ones are counted by state, not by colour.
    expect(states.filter((state) => state === 'learning').length).toBeGreaterThanOrEqual(2);
    expect(summary.cards.filter((card) => card.fsrs.state === 0).length).toBeGreaterThanOrEqual(1);
    // One card is consolidated (two Easy grades, months apart) so the demo has
    // an example of a word on its way out of the queue.
    expect(states.filter((state) => state === 'known').length).toBeLessThanOrEqual(1);
  });

  it('resetAll empties every table', async () => {
    const repo = setup();
    await loadDemo({ repo, now: NOW, source: dictEntrySource() });
    await resetAll(repo);
    expect(await repo.allCards()).toEqual([]);
    expect(await repo.lists()).toEqual([]);
    expect(await repo.texts()).toEqual([]);
    expect(await repo.knownEntryIds()).toEqual([]);
  });
});

describe('the ask cache key', () => {
  it('is a sha1 over prompt version, provider, query, context and band', () => {
    const key = demoAskCacheKey({ query: 'hello', context: 'a', estimatedBand: 3 });
    expect(key).toBe(sha1Hex(JSON.stringify(['v1', 'fake', 'hello', 'a', 3])));
    // Context is part of the key: the same question about a different sentence
    // is a different question (§3.4).
    expect(demoAskCacheKey({ query: 'hello', context: 'b', estimatedBand: 3 })).not.toBe(key);
  });
});

describe('sentenceAround', () => {
  it('bounds the sentence on Chinese punctuation and locates the word inside it', () => {
    const found = sentenceAround('我起床。然后去公园跑步。回家吃早饭。', '跑步');
    expect(found?.sentence).toBe('然后去公园跑步。');
    expect(found?.offset).toBe(5);
  });

  it('returns null for a word the text does not contain', () => {
    expect(sentenceAround('我起床。', '跑步')).toBeNull();
  });
});
