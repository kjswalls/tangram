/**
 * The auto-draw order (PLAN.md §3.3): user lists before the spine, band order
 * inside the spine, frequency order inside a band, and nothing already met.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Repository } from '@/lib/db/repository';
import { collectDrawCandidates } from '@/lib/lists/draw';
import { ensureSystemLists, findHskList, hskListName } from '@/lib/lists/system-lists';
import { requireDictData } from '../dict/data-required';
import { dictEntrySource, entry, fakeEntrySource, freshRepository } from './helpers';

let close: (() => void) | undefined;

beforeAll(() => {
  requireDictData();
});

afterEach(() => {
  close?.();
  close = undefined;
});

function setup(): Repository {
  const { db, repo } = freshRepository();
  close = () => db.close();
  return repo;
}

describe('collectDrawCandidates', () => {
  it('draws the spine from spineStartBand upward, in frequency order', async () => {
    const repo = setup();
    const lists = await ensureSystemLists(repo);
    const source = dictEntrySource();
    const settings = await repo.getSettings();

    const candidates = await collectDrawCandidates({ repo, settings, lists, limit: 5, source });
    expect(candidates).toHaveLength(5);
    const band3 = await source.band(3);
    expect(candidates.map((row) => row.entryId)).toEqual(band3.slice(0, 5).map((row) => row.id));
    for (const candidate of candidates) {
      expect(candidate.from).toBe('spine');
      expect(candidate.band).toBe(3);
      expect(candidate.listId).toBe(findHskList(lists, 3)?.id);
    }
    // Bands below the start band are never fetched, let alone drawn.
    expect(source.bandCalls).not.toContain(1);
  });

  it('moves to the next band when the current one is exhausted', async () => {
    const repo = setup();
    const lists = await ensureSystemLists(repo);
    const source = fakeEntrySource({
      3: [entry({ simp: '甲' })],
      4: [entry({ simp: '乙' }), entry({ simp: '丙' })],
    });
    const settings = await repo.getSettings();
    const candidates = await collectDrawCandidates({ repo, settings, lists, limit: 3, source });
    expect(candidates.map((row) => row.band)).toEqual([3, 4, 4]);
  });

  it('skips an inactive band and everything the learner has already met', async () => {
    const repo = setup();
    const lists = await ensureSystemLists(repo);
    const met = entry({ simp: '甲' });
    const wanted = entry({ simp: '乙' });
    const source = fakeEntrySource({ 3: [met, wanted], 4: [entry({ simp: '丙' })] });
    await repo.markKnown([met.id]);
    const band4 = findHskList(lists, 4);
    await repo.setListActive(band4!.id, false);

    const settings = await repo.getSettings();
    const candidates = await collectDrawCandidates({
      repo,
      settings,
      lists: await repo.lists(),
      limit: 5,
      source,
    });
    expect(candidates.map((row) => row.entryId)).toEqual([wanted.id]);
  });

  it('skips variants and proper nouns only outside the bands', async () => {
    const repo = setup();
    const lists = await ensureSystemLists(repo);
    const source = fakeEntrySource({
      3: [
        entry({ simp: '北京', properNoun: true, hskBand: 3 }),
        entry({ simp: '一点儿', isVariant: true, hskBand: 3 }),
        // No band: the plan's skip applies, and it is the only place it does.
        entry({ simp: '某某', properNoun: true }),
      ],
    });
    const settings = await repo.getSettings();
    const candidates = await collectDrawCandidates({ repo, settings, lists, limit: 5, source });
    expect(candidates.map((row) => row.entryId)).toEqual(
      (await source.band(3)).slice(0, 2).map((row) => row.id),
    );
  });

  it('walks active user lists before the spine, in list order', async () => {
    const repo = setup();
    await ensureSystemLists(repo);
    const mine = await repo.createList({ name: 'Kitchen', kind: 'custom', order: 20 });
    const later = await repo.createList({ name: 'Office', kind: 'custom', order: 21 });
    const kitchen = entry({ simp: '锅' });
    const office = entry({ simp: '打印机' });
    const spine = entry({ simp: '甲' });
    await repo.addListMembers(mine.id, [kitchen.id]);
    await repo.addListMembers(later.id, [office.id]);

    const source = fakeEntrySource({ 3: [spine] });
    const settings = await repo.getSettings();
    const candidates = await collectDrawCandidates({
      repo,
      settings,
      lists: await repo.lists(),
      limit: 5,
      source,
    });
    expect(candidates.map((row) => row.entryId)).toEqual([kitchen.id, office.id, spine.id]);
    expect(candidates.map((row) => row.from)).toEqual(['list', 'list', 'spine']);
  });

  it('skips a deactivated user list', async () => {
    const repo = setup();
    await ensureSystemLists(repo);
    const mine = await repo.createList({ name: 'Kitchen', kind: 'custom', order: 20 });
    const kitchen = entry({ simp: '锅' });
    await repo.addListMembers(mine.id, [kitchen.id]);
    await repo.setListActive(mine.id, false);

    const source = fakeEntrySource({ 3: [entry({ simp: '甲' })] });
    const settings = await repo.getSettings();
    const candidates = await collectDrawCandidates({
      repo,
      settings,
      lists: await repo.lists(),
      limit: 5,
      source,
    });
    expect(candidates.map((row) => row.from)).toEqual(['spine']);
  });

  it('starts at settings.spineStartBand and never below it', async () => {
    const repo = setup();
    const lists = await ensureSystemLists(repo);
    const source = fakeEntrySource({
      3: [entry({ simp: '甲' })],
      4: [entry({ simp: '乙' })],
      5: [entry({ simp: '丙' })],
    });
    const settings = await repo.setSettings({ spineStartBand: 5 });
    const candidates = await collectDrawCandidates({ repo, settings, lists, limit: 5, source });
    expect(candidates.map((row) => row.band)).toEqual([5]);
  });

  it('never draws a band the learner is assumed to know', async () => {
    const repo = setup();
    const lists = await ensureSystemLists(repo);
    const source = fakeEntrySource({
      3: [entry({ simp: '甲', hskBand: 3 })],
      4: [entry({ simp: '乙', hskBand: 4 })],
    });
    // knownBand above spineStartBand: the low band is known, so it is skipped.
    const settings = await repo.setSettings({ spineStartBand: 3, knownBand: 3 });
    const candidates = await collectDrawCandidates({ repo, settings, lists, limit: 5, source });
    expect(candidates.map((row) => row.band)).toEqual([4]);
  });

  it('asks the dictionary for nothing when the cap is spent', async () => {
    const repo = setup();
    const lists = await ensureSystemLists(repo);
    const source = dictEntrySource();
    const settings = await repo.getSettings();
    expect(await collectDrawCandidates({ repo, settings, lists, limit: 0, source })).toEqual([]);
    expect(source.bandCalls).toEqual([]);
  });
});

describe('ensureSystemLists', () => {
  it('creates seven HSK lists and Looked up, once', async () => {
    const repo = setup();
    const [first, second] = await Promise.all([ensureSystemLists(repo), ensureSystemLists(repo)]);
    expect(first).toHaveLength(8);
    expect(second).toHaveLength(8);
    expect((await repo.lists()).map((row) => row.name)).toEqual([
      'Looked up',
      hskListName(1),
      hskListName(2),
      hskListName(3),
      hskListName(4),
      hskListName(5),
      hskListName(6),
      hskListName(7),
    ]);
    expect(hskListName(7)).toBe('HSK 7–9');
    expect((await repo.lists()).every((row) => row.owner === 'system' && row.active)).toBe(true);

    // A second call on a database that already has them adds nothing.
    await ensureSystemLists(repo);
    expect(await repo.lists()).toHaveLength(8);
  });
});
