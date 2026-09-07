/**
 * `FakeProvider` (PLAN.md §3.4): the demo set, and the guarantee that no query
 * ever renders an empty panel.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { FakeProvider, retrievalEcho } from '@/lib/ai/fake';
import { askResponseSchema } from '@/lib/ai/provider';
import { ground } from '@/lib/ai/ground';
import type { LearnerProfile } from '@/lib/types';
import { requireDictData } from '../dict/data-required';
import { entriesFor, entryFor, groundContext, readingOf } from './helpers';

beforeAll(requireDictData);

const PROFILE: LearnerProfile = { estimatedBand: 2, knownSample: ['我', '是'] };
const fake = new FakeProvider();

const BROWSING = "how do I say I'm just browsing";

describe('the demo set', () => {
  it('proposes the phrases the browsing answer is built from', async () => {
    const { candidates } = await fake.proposePhrases(BROWSING);
    expect(candidates).toContain('我随便看看');
    expect(candidates.length).toBeLessThanOrEqual(8);
  });

  it('answers the browsing sentence with cited ids, resolved at request time', async () => {
    const retrieved = entriesFor('我', '随便', '看看', '只是');
    const answer = await fake.answer(retrieved, PROFILE, BROWSING);

    expect(askResponseSchema.safeParse(answer).success).toBe(true);
    expect(answer.sayIt.length).toBeGreaterThanOrEqual(2);

    // Nothing is a literal id in a fixture: every citation is an id that came
    // out of the dictionary the route retrieved from.
    const ids = new Set(retrieved.map((entry) => entry.id));
    for (const phrase of answer.sayIt) {
      for (const token of phrase.tokens) {
        expect('entryId' in token && ids.has(token.entryId)).toBe(true);
      }
    }
    for (const match of answer.matches) expect(ids.has(match.entryId)).toBe(true);

    const grounded = ground(answer, groundContext(retrieved));
    expect(grounded.matches.length).toBeGreaterThanOrEqual(1);
    expect(grounded.sayIt.length).toBeGreaterThanOrEqual(1);
    // 我随便看看 and 我只是看看 are ordinary words: nothing to warn about.
    expect(grounded.sayIt.every((phrase) => !phrase.unverified)).toBe(true);
    expect(grounded.sayIt[0].tokens.map((token) => token.entryId)).toEqual([
      entryFor('我').id,
      entryFor('随便').id,
      entryFor('看看').id,
    ]);
  });

  it('falls back to the echo when a word the demo wants was not retrieved', async () => {
    // 看看 missing: the canned answer cannot be rendered, so it is abandoned
    // rather than half-shown.
    const retrieved = entriesFor('我', '随便');
    const answer = await fake.answer(retrieved, PROFILE, BROWSING);
    expect(answer.sayIt).toEqual([]);
    expect(answer.matches.every((match) => match.whyThisOne === 'dictionary match')).toBe(true);
  });

  it('picks a different sense for 看 depending on the sentence around it', async () => {
    const retrieved = entriesFor('看');
    const lookedAt = await fake.answer(retrieved, PROFILE, '看', { sentence: '我看了一下' });
    const lookedAfter = await fake.answer(retrieved, PROFILE, '看', { sentence: '你看着孩子' });

    const kan4 = readingOf('看', 'kan4');
    const kan1 = readingOf('看', 'kan1');

    expect(lookedAt.matches[0]).toMatchObject({ entryId: kan4.id, senseIndex: 0 });
    expect(lookedAfter.matches[0]).toMatchObject({ entryId: kan1.id, senseIndex: 0 });

    // Different entry *and* a different index: the caretaking answer also
    // points at the "look after" sense of the fourth-tone reading, which is the
    // one a learner is most likely to have confused it with.
    const chosen = (answer: { matches: { entryId: string; senseIndex: number }[] }) =>
      answer.matches.map((match) => `${match.entryId}#${match.senseIndex}`);
    expect(chosen(lookedAt)).not.toEqual(chosen(lookedAfter));
    expect(chosen(lookedAfter)).toContain(`${kan4.id}#5`);
    expect(kan4.glosses[5]).toMatch(/look after/);

    for (const answer of [lookedAt, lookedAfter]) {
      const grounded = ground(answer, groundContext(retrieved));
      expect(grounded.matches.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('answers a pinyin query, tones or no tones', async () => {
    const retrieved = entriesFor('打算', '我');
    for (const query of ['dasuan', 'da3suan4', 'dǎsuàn']) {
      const answer = await fake.answer(retrieved, PROFILE, query);
      expect(answer.matches[0]).toMatchObject({ entryId: entryFor('打算').id, senseIndex: 0 });
      expect(answer.sayIt[0].tokens).toHaveLength(2);
    }
  });

  it('answers a reader tap: a word plus the sentence it was tapped in', async () => {
    const retrieved = entriesFor('开始');
    const answer = await fake.answer(retrieved, PROFILE, '开始', { sentence: '我们开始吧' });
    expect(answer.matches[0]).toMatchObject({ entryId: entryFor('开始').id, senseIndex: 0 });
    expect(answer.notes.length).toBeGreaterThan(0);
  });
});

describe('the retrieval echo', () => {
  it('cites the top five retrieved entries', async () => {
    const retrieved = entriesFor('看', '看到', '看见', '看病', '看法', '看来');
    const answer = await fake.answer(retrieved, PROFILE, 'something nobody scripted');

    expect(answer.matches).toHaveLength(5);
    expect(answer.matches.every((match) => match.whyThisOne === 'dictionary match')).toBe(true);
    expect(answer.matches[0].entryId).toBe(retrieved[0].id);
    expect(answer.sayIt).toEqual([]);
    expect(answer.interpretation).toContain(retrieved[0].pinyinMarked);
  });

  it('says something even when nothing was retrieved', () => {
    const answer = retrievalEcho([], 'qqqq');
    expect(answer.interpretation).not.toBe('');
    expect(answer.notes.length).toBeGreaterThan(0);
    expect(askResponseSchema.safeParse(answer).success).toBe(true);
  });

  it('writes prose that survives the CJK strip', async () => {
    const retrieved = entriesFor('打算');
    const answer = await fake.answer(retrieved, PROFILE, 'unscripted');
    const grounded = ground(answer, groundContext(retrieved));
    // The echo names the reading, not the headword, so grounding leaves the
    // sentence intact instead of punching a hole in it.
    expect(grounded.interpretation).toContain('dǎsuàn');
    expect(grounded.interpretation).toBe(answer.interpretation);
  });
});
