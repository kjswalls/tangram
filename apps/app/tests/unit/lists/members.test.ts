/**
 * Membership and the Looked up list (PLAN.md §3.3, §4 P3).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Repository } from '@/lib/db/repository';
import { scoreEntry } from '@/lib/lists/entry-source';
import { addCardTracked, isExplicitSource, joinLookedUp } from '@/lib/lists/looked-up';
import { ensureMembers, markListKnown, memberEntryIds } from '@/lib/lists/members';
import { ensureSystemLists, findHskList, findLookedUpList } from '@/lib/lists/system-lists';
import { entry, fakeEntrySource, freshRepository } from './helpers';

const NOW = new Date(2026, 8, 7, 12).getTime();
let close: (() => void) | undefined;

afterEach(() => {
  close?.();
  close = undefined;
});

function setup(): Repository {
  const { db, repo } = freshRepository();
  close = () => db.close();
  return repo;
}

describe('ensureMembers', () => {
  it('fills an HSK list from the dictionary once, and never again', async () => {
    const repo = setup();
    const lists = await ensureSystemLists(repo);
    const band3 = findHskList(lists, 3)!;
    let calls = 0;
    const source = fakeEntrySource({ 3: [entry({ simp: '甲' }), entry({ simp: '乙' })] });
    const counted = {
      ...source,
      band: async (band: 1 | 2 | 3 | 4 | 5 | 6 | 7) => {
        calls += 1;
        return source.band(band);
      },
    };

    const first = await ensureMembers(repo, band3, counted);
    expect(first).toHaveLength(2);
    expect(calls).toBe(1);

    const second = await ensureMembers(repo, band3, counted);
    expect(second.map((row) => row.entryId)).toEqual(first.map((row) => row.entryId));
    expect(calls).toBe(1);

    // Membership is entry ids: no `words` rows are created by listing a band.
    expect(second.every((row) => row.wordId === null)).toBe(true);
    expect(await repo.wordByEntryId(second[0].entryId)).toBeUndefined();
  });

  it('leaves a user list alone — there is nothing to fill it from', async () => {
    const repo = setup();
    const mine = await repo.createList({ name: 'Kitchen', kind: 'custom' });
    const source = fakeEntrySource({ 3: [entry({ simp: '甲' })] });
    expect(await ensureMembers(repo, mine, source)).toEqual([]);
    await repo.addListMembers(mine.id, ['x|x[xx1]']);
    expect(await memberEntryIds(repo, mine, source)).toEqual(['x|x[xx1]']);
  });

  it('two callers at once materialise one copy', async () => {
    const repo = setup();
    const lists = await ensureSystemLists(repo);
    const band3 = findHskList(lists, 3)!;
    const source = fakeEntrySource({ 3: [entry({ simp: '甲' }), entry({ simp: '乙' })] });
    const [a, b] = await Promise.all([
      ensureMembers(repo, band3, source),
      ensureMembers(repo, band3, source),
    ]);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(await repo.listMembers(band3.id)).toHaveLength(2);
  });

  it('marks every word in a list known, materialising it if it has to', async () => {
    const repo = setup();
    const lists = await ensureSystemLists(repo);
    const band3 = findHskList(lists, 3)!;
    const words = [entry({ simp: '甲' }), entry({ simp: '乙' })];
    const source = fakeEntrySource({ 3: words });

    expect(await markListKnown(repo, band3, source)).toBe(2);
    expect(new Set(await repo.knownEntryIds())).toEqual(new Set(words.map((row) => row.id)));
  });
});

describe('the Looked up list', () => {
  it('takes every explicit add and nothing else', async () => {
    const repo = setup();
    const looked = entry({ simp: '锅' });
    const drawn = entry({ simp: '甲' });

    await addCardTracked(repo, looked, { source: 'lookup', query: '锅', addedAt: NOW });
    await addCardTracked(repo, drawn, { source: 'list', addedAt: NOW });

    const list = findLookedUpList(await repo.lists())!;
    expect(list.kind).toBe('looked-up');
    expect(list.owner).toBe('system');
    expect((await repo.listMembers(list.id)).map((row) => row.entryId)).toEqual([looked.id]);
  });

  it('does not add the same word twice', async () => {
    const repo = setup();
    const looked = entry({ simp: '锅' });
    await addCardTracked(repo, looked, { source: 'reader', sentence: '我买了一个锅。', addedAt: NOW });
    await joinLookedUp(repo, [looked.id, looked.id]);
    const list = findLookedUpList(await repo.lists())!;
    expect(await repo.listMembers(list.id)).toHaveLength(1);
    // And the card itself is idempotent per (entryId, senseIndex).
    expect(await repo.allCards()).toHaveLength(1);
  });

  it('knows which sources count as explicit', () => {
    expect(isExplicitSource('lookup')).toBe(true);
    expect(isExplicitSource('ask')).toBe(true);
    expect(isExplicitSource('reader')).toBe(true);
    expect(isExplicitSource('list')).toBe(false);
    expect(isExplicitSource('seed')).toBe(false);
    expect(isExplicitSource(undefined)).toBe(false);
  });
});

describe('the fallback word search', () => {
  const paobu = entry({
    simp: '跑步',
    trad: '跑步',
    pinyinNum: 'pao3 bu4',
    pinyinMarked: 'pǎobù',
    glosses: ['to run', 'to jog'],
    hskBand: 3,
  });

  it('ranks an exact headword above a prefix, and pinyin above a gloss', () => {
    const exact = scoreEntry(paobu, '跑步')!;
    const prefix = scoreEntry({ ...paobu, simp: '跑步机', trad: '跑步機' }, '跑步')!;
    const toned = scoreEntry(paobu, 'pao3bu4')!;
    const toneless = scoreEntry(paobu, 'paobu')!;
    const gloss = scoreEntry(paobu, 'run')!;
    expect(exact).toBeLessThan(prefix);
    expect(prefix).toBeLessThan(toned);
    expect(toned).toBeLessThan(toneless);
    expect(toneless).toBeLessThan(gloss);
  });

  it('penalises variants and proper nouns, and drops what does not match', () => {
    expect(scoreEntry({ ...paobu, isVariant: true }, '跑步')!).toBeGreaterThan(scoreEntry(paobu, '跑步')!);
    expect(scoreEntry(paobu, '吃饭')).toBeUndefined();
    expect(scoreEntry(paobu, 'to eat')).toBeUndefined();
    expect(scoreEntry(paobu, '  ')).toBeUndefined();
  });
});
