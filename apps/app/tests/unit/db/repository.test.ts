import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, isPhraseSnapshot } from '@/lib/db/schema';
import { isExplicitAdd } from '@/lib/lists/queue';
import { context, DASUAN, freshRepository, KANKAN } from './fixtures';

const DAY = 86_400_000;
let close: (() => void) | undefined;

function setup() {
  const { db, repo } = freshRepository();
  close = () => db.close();
  return repo;
}

afterEach(() => {
  close?.();
  close = undefined;
});

describe('settings', () => {
  it('creates the singleton with the plan defaults and patches it', async () => {
    const repo = setup();
    const settings = await repo.getSettings();
    expect(settings).toMatchObject({
      id: 'singleton',
      newPerDay: 10,
      spineStartBand: 3,
      knownBand: 2,
      dayRollover: 4,
      script: 'simp',
      provider: 'fake',
    });
    expect(settings.introduced).toEqual({});
    expect(DEFAULT_SETTINGS.newPerDay).toBe(10);

    const patched = await repo.setSettings({ newPerDay: 3, introduced: { '2026-09-07': 2 } });
    expect(patched.newPerDay).toBe(3);
    expect((await repo.getSettings()).introduced).toEqual({ '2026-09-07': 2 });
  });
});

describe('cards', () => {
  it('adds a card from an entry, with a word row and provenance', async () => {
    const repo = setup();
    const card = await repo.addCardFromEntry(DASUAN, context(), 0, 'test-dict');

    expect(card.kind).toBe('word');
    expect(card.entryId).toBe(DASUAN.id);
    expect(card.wordId).toBeTruthy();
    expect(card.deletedAt).toBeNull();
    expect(card.fsrs.state).toBe(0);
    expect(card.due).toBe(card.fsrs.due);
    expect(card.context?.sentence).toBe('我打算明天去北京。');
    expect(card.senseIndex).toBe(0);

    const word = await repo.wordByEntryId(DASUAN.id);
    expect(word?.snapshot.pinyinMarked).toBe('dǎsuàn');
    expect(word?.snapshot.dictVersion).toBe('test-dict');
    // Decomposition data never enters a snapshot: different licence.
    expect(word?.snapshot).not.toHaveProperty('decomposition');
  });

  it('is idempotent per entry and sense', async () => {
    const repo = setup();
    const first = await repo.addCardFromEntry(DASUAN);
    const again = await repo.addCardFromEntry(DASUAN);
    const otherSense = await repo.addCardFromEntry(DASUAN, undefined, 1);

    expect(again.id).toBe(first.id);
    expect(otherSense.id).not.toBe(first.id);
    expect((await repo.allCards()).length).toBe(2);
  });

  it('gives an existing card the provenance a later Add carries', async () => {
    const repo = setup();
    // The spine drew it this morning, so the card exists and knows nothing about
    // where the learner met it.
    const drawn = await repo.addCardFromEntry(DASUAN, { source: 'list', addedAt: 1 });
    expect(drawn.context?.sentence).toBeUndefined();

    // Now they read it in a sentence and press Add. Same card, new provenance:
    // without this the reader's Add is a silent no-op and the review back has
    // nothing to highlight.
    const added = await repo.addCardFromEntry(DASUAN, context({ addedAt: 2 }));
    expect(added.id).toBe(drawn.id);
    expect(added.context?.sentence).toBe('我打算明天去北京。');
    expect(added.context?.offset).toBe(1);
    // Promoted out of the spine: an explicit add is always in today's queue.
    expect(added.context?.source).toBe('reader');
    expect(isExplicitAdd(added)).toBe(true);
    expect(added.updatedAt).toBeGreaterThanOrEqual(drawn.updatedAt);
    expect((await repo.allCards()).length).toBe(1);
    expect((await repo.cardForEntry(DASUAN.id))?.context?.sentence).toBe('我打算明天去北京。');

    // A poorer context never overwrites a richer one, and the source it was
    // promoted to stays put.
    const third = await repo.addCardFromEntry(DASUAN, {
      source: 'lookup',
      query: 'dasuan',
      addedAt: 3,
    });
    expect(third.context?.source).toBe('reader');
    expect(third.context?.sentence).toBe('我打算明天去北京。');
    expect(third.context?.query).toBe('dasuan');
  });

  it('finds the card for an entry, or nothing when there is none', async () => {
    const repo = setup();
    expect(await repo.cardForEntry(DASUAN.id)).toBeUndefined();
    const card = await repo.addCardFromEntry(DASUAN, context(), 1);
    // Sense-specific, exactly as `addCardFromEntry` is.
    expect(await repo.cardForEntry(DASUAN.id)).toBeUndefined();
    expect((await repo.cardForEntry(DASUAN.id, 1))?.id).toBe(card.id);
  });

  it('survives a double tap: two concurrent adds make one card', async () => {
    const { db, repo } = freshRepository();
    close = () => db.close();
    // Two Adds in flight at once is what a double-tapped button looks like; the
    // read-check-write has to be one transaction or both see an empty table.
    const [first, second] = await Promise.all([
      repo.addCardFromEntry(DASUAN),
      repo.addCardFromEntry(DASUAN),
    ]);

    expect(second.id).toBe(first.id);
    expect(await db.cards.count()).toBe(1);
    expect(await db.words.count()).toBe(1);
  });

  it('carries the frequency rank into the snapshot, for the learner profile', async () => {
    const repo = setup();
    const card = await repo.addCardFromEntry(DASUAN);
    expect(isPhraseSnapshot(card.snapshot) ? undefined : card.snapshot.freqRank).toBe(
      DASUAN.freqRank,
    );
  });

  it('adds a phrase card whose snapshot is the rendered tokens', async () => {
    const repo = setup();
    const card = await repo.addPhraseCard(
      [
        { text: '我', entryId: '我|我[wo3]', pinyinMarked: 'wǒ' },
        { text: '随便', entryId: '隨便|随便[sui2 bian4]', pinyinMarked: 'suíbiàn' },
        { text: '看看', entryId: KANKAN.id, pinyinMarked: 'kànkan' },
      ],
      "I'm just browsing",
      context({ source: 'ask', question: 'how do I say I am just browsing' }),
    );

    expect(card.kind).toBe('phrase');
    expect(card.wordId).toBeNull();
    if (!isPhraseSnapshot(card.snapshot)) throw new Error('expected a phrase snapshot');
    expect(card.snapshot.simp).toBe('我随便看看');
    expect(card.snapshot.pinyinMarked).toBe('wǒ suíbiàn kànkan');
    expect(card.snapshot.tokens).toHaveLength(3);
  });

  it('records the dictionary a phrase was cut from, and says so when it was not told', async () => {
    const repo = setup();
    const tokens = [{ text: '我', entryId: '我|我[wo3]', pinyinMarked: 'wǒ' }];

    const stamped = await repo.addPhraseCard(
      tokens,
      'me',
      context({ source: 'ask' }),
      '1.3.20251213',
    );
    expect(stamped.snapshot.dictVersion).toBe('1.3.20251213');

    // No fourth argument is not a version: it is the absence of one, and the
    // snapshot has to say that rather than name a dictionary it cannot know.
    const bare = await repo.addPhraseCard(tokens, 'me', context({ source: 'ask' }));
    expect(bare.snapshot.dictVersion).toBe('unknown');
  });
});

describe('queues', () => {
  it('lists due cards oldest first and never offers a New card as due', async () => {
    const repo = setup();
    const now = Date.now();
    const fresh = await repo.addCardFromEntry(DASUAN);
    expect(await repo.listDue(now + DAY)).toEqual([]);

    await repo.grade(fresh.id, 3, now - 3 * DAY);
    const due = await repo.listDue(now + 30 * DAY);
    expect(due.map((card) => card.id)).toEqual([fresh.id]);
    expect(due[0].fsrs.state).not.toBe(0);
  });

  it('lists new candidates oldest first', async () => {
    const repo = setup();
    const first = await repo.addCardFromEntry(DASUAN);
    const second = await repo.addCardFromEntry(KANKAN);
    const candidates = await repo.newCandidates(10);
    expect(candidates.map((card) => card.id)).toEqual([first.id, second.id]);
    expect(await repo.newCandidates(1)).toHaveLength(1);
  });

  it('finds learning cards coming due inside the horizon', async () => {
    const repo = setup();
    const now = Date.now();
    const card = await repo.addCardFromEntry(DASUAN);
    await repo.grade(card.id, 1, now);
    // With `shortTermSteps` on (the default since Phase 8) Again puts the card
    // in Learning, one step out — so it is inside a three-day horizon *and*
    // inside a one-minute one. Both are the same claim: not yet consolidated.
    const soon = await repo.listLearningSoon(now, 3 * DAY);
    expect(soon.map((row) => row.id)).toEqual([card.id]);
    expect((await repo.listLearningSoon(now, 60 * 1000)).map((row) => row.id)).toEqual([card.id]);

    // Turn the steps off and the same grade lands a day out, which is v1's
    // behaviour and is still one settings column away.
    await repo.setSettings({ shortTermSteps: false });
    const other = await repo.addCardFromEntry(KANKAN);
    await repo.grade(other.id, 1, now);
    // Inside the minute there is still only the card that was failed *before*
    // the change: the second one is a day out.
    expect((await repo.listLearningSoon(now, 60 * 1000)).map((row) => row.id)).toEqual([card.id]);
    expect((await repo.listLearningSoon(now, 3 * DAY)).map((row) => row.id)).toContain(other.id);
  });
});

describe('grading', () => {
  it('writes the new state, the mirrored due column and an append-only review row', async () => {
    const repo = setup();
    const now = Date.now();
    const card = await repo.addCardFromEntry(DASUAN);
    const before = card.fsrs;

    const { card: graded, review } = await repo.grade(card.id, 3, now);

    expect(graded.fsrs.state).not.toBe(0);
    expect(graded.fsrs.reps).toBe(1);
    expect(graded.due).toBe(graded.fsrs.due);
    // `shortTermSteps` defaults on (Phase 8), so Good on a *new* card is a
    // learning step of minutes, not a day. It still moves, and it still
    // mirrors onto the indexed column, which is what this test is about.
    expect(graded.due).toBeGreaterThan(now);
    expect(graded.fsrs.last_review).toBe(now);

    expect(review.cardId).toBe(card.id);
    expect(review.rating).toBe(3);
    expect(review.reviewedAt).toBe(now);
    expect(review.before).toEqual(before);
    expect(typeof review.log.due).toBe('number');
    expect(review.log.review).toBe(now);

    const second = await repo.grade(card.id, 4, now + DAY);
    expect(second.review.before).toEqual(graded.fsrs);
    expect(second.card.fsrs.reps).toBe(2);
  });

  it('refuses to grade a card that is not there', async () => {
    const repo = setup();
    await expect(repo.grade('missing', 3)).rejects.toThrow(/no card/);
  });
});

describe('known words', () => {
  it('records the entry once and pushes an existing card out of the queue', async () => {
    const repo = setup();
    const now = Date.now();
    const card = await repo.addCardFromEntry(DASUAN);

    await repo.markKnown([DASUAN.id, DASUAN.id, KANKAN.id]);
    await repo.markKnown([DASUAN.id]);

    expect((await repo.knownEntryIds()).sort()).toEqual([DASUAN.id, KANKAN.id].sort());
    const [updated] = (await repo.allCards()).filter((row) => row.id === card.id);
    expect(updated.fsrs.state).toBe(2);
    expect(updated.fsrs.stability).toBeGreaterThanOrEqual(21);
    expect(updated.due).toBeGreaterThan(now + 300 * DAY);
    expect(await repo.listDue(now + 30 * DAY)).toEqual([]);
  });
});

describe('lists', () => {
  it('creates, orders, filters and toggles', async () => {
    const repo = setup();
    const hsk = await repo.createList({ name: 'HSK 1', kind: 'hsk', owner: 'system', band: 1, order: 0 });
    const custom = await repo.createList({ name: 'Menu words', kind: 'custom', order: 1 });

    expect((await repo.lists()).map((row) => row.name)).toEqual(['HSK 1', 'Menu words']);

    const added = await repo.addListMembers(custom.id, [DASUAN.id, KANKAN.id, DASUAN.id]);
    expect(added).toHaveLength(2);
    const members = await repo.listMembers(custom.id);
    expect(members.map((row) => row.entryId)).toEqual([DASUAN.id, KANKAN.id]);
    expect(await repo.listMembers(hsk.id)).toEqual([]);

    const off = await repo.setListActive(hsk.id, false);
    expect(off?.active).toBe(false);
    expect(await repo.setListActive('missing', true)).toBeUndefined();
  });

  it('renames a list, refusing an empty name and an id that is not there', async () => {
    const repo = setup();
    const custom = await repo.createList({ name: 'Menu words', kind: 'custom' });

    const renamed = await repo.renameList(custom.id, '  Restaurant  ');
    expect(renamed?.name).toBe('Restaurant');
    expect((await repo.lists())[0].name).toBe('Restaurant');
    expect(await repo.renameList(custom.id, '   ')).toBeUndefined();
    expect((await repo.lists())[0].name).toBe('Restaurant');
    expect(await repo.renameList('missing', 'Nope')).toBeUndefined();
  });

  it('removes members without touching the cards they made', async () => {
    const repo = setup();
    const custom = await repo.createList({ name: 'Menu words', kind: 'custom' });
    await repo.addListMembers(custom.id, [DASUAN.id, KANKAN.id]);
    await repo.addCardFromEntry(DASUAN);

    expect(await repo.removeListMembers(custom.id, [DASUAN.id])).toBe(1);
    expect((await repo.listMembers(custom.id)).map((row) => row.entryId)).toEqual([KANKAN.id]);
    // A word taken out of a list is not a word un-learned.
    expect(await repo.allCards()).toHaveLength(1);
    // Idempotent: a second removal has nothing left to tombstone.
    expect(await repo.removeListMembers(custom.id, [DASUAN.id])).toBe(0);
    expect(await repo.removeListMembers(custom.id, [])).toBe(0);
  });

  it('deletes a list and its membership together', async () => {
    const repo = setup();
    const custom = await repo.createList({ name: 'Menu words', kind: 'custom' });
    const other = await repo.createList({ name: 'Keep me', kind: 'custom' });
    await repo.addListMembers(custom.id, [DASUAN.id]);
    await repo.addListMembers(other.id, [KANKAN.id]);

    await repo.deleteList(custom.id);
    expect((await repo.lists()).map((row) => row.name)).toEqual(['Keep me']);
    // No orphaned membership: a live member row under a tombstoned list could
    // never be read or cleaned up again.
    expect(await repo.listMembers(custom.id)).toEqual([]);
    expect(await repo.listMembers(other.id)).toHaveLength(1);
    // Deleting twice, or deleting nothing, is not an error.
    await repo.deleteList(custom.id);
    await repo.deleteList('missing');
    expect(await repo.lists()).toHaveLength(1);
  });
});

describe('texts, ask cache and reset', () => {
  it('saves a text, updates it in place and lists newest first', async () => {
    const repo = setup();
    const first = await repo.saveText({ title: 'Paragraph', body: '我随便看看。' });
    const updated = await repo.saveText({ id: first.id, title: 'Paragraph', body: '我打算明天去。' });
    expect(updated.id).toBe(first.id);
    expect((await repo.texts()).map((row) => row.body)).toEqual(['我打算明天去。']);
  });

  it('stores ask responses by cache key', async () => {
    const repo = setup();
    expect(await repo.askCache.get('key')).toBeUndefined();
    await repo.askCache.set('key', { matches: [{ entryId: DASUAN.id, senseIndex: 0 }] });
    const row = await repo.askCache.get('key');
    expect(row?.id).toBe('key');
    expect(row?.response).toEqual({ matches: [{ entryId: DASUAN.id, senseIndex: 0 }] });
  });

  it('resetAll empties every table', async () => {
    const repo = setup();
    await repo.addCardFromEntry(DASUAN);
    await repo.saveText({ title: 't', body: 'b' });
    await repo.markKnown([KANKAN.id]);
    await repo.getSettings();

    await repo.resetAll();

    expect(await repo.allCards()).toEqual([]);
    expect(await repo.texts()).toEqual([]);
    expect(await repo.knownEntryIds()).toEqual([]);
    expect(await repo.wordByEntryId(DASUAN.id)).toBeUndefined();
    // The settings singleton is recreated on demand, with the defaults back.
    expect((await repo.getSettings()).newPerDay).toBe(10);
  });
});
