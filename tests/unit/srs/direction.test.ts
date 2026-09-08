/**
 * The production direction, in the pure half (Phase 8, builder B):
 * what a produced answer is judged against, what a production front is allowed
 * to show, and which recognition cards want a twin.
 *
 * The rules being pinned here are the ones a screenshot would not catch:
 *
 *  - an exact answer is settled **in the browser** — the provider is not asked,
 *    and the test proves it by handing over a fallback that throws if called;
 *  - either script counts, whichever the learner reads in;
 *  - nothing a production front renders contains the answer, including the
 *    glosses that quote the headword and the sentence that says it twice;
 *  - a twin plan never exceeds the limit it is given, which is what stops
 *    "also study production" from doubling an established queue in one press.
 */
import { describe, expect, it, vi } from 'vitest';

import type { CardRow, EntrySnapshot } from '@/lib/db/schema';
import {
  addProductionTwins,
  countByDirection,
  editDistance,
  entryFromSnapshot,
  gradeProduction,
  hasProductionTwin,
  maskTargets,
  normalizeProduced,
  planProductionTwins,
  preferRecognition,
  productionRecallRequest,
  revealsTarget,
  spaceDirections,
  twinContext,
  twinKey,
} from '@/lib/srs/direction';
import type { CardDirection } from '@/lib/db/schema';

const DASUAN: EntrySnapshot = {
  simp: '打算',
  trad: '打算',
  pinyinMarked: 'dǎsuàn',
  pinyinNum: 'da3 suan4',
  glosses: ['to plan', 'to intend'],
  classifiers: ['个'],
  hskBand: 2,
  freqRank: 1200,
  dictVersion: 'test',
};

/** A word whose two scripts differ, for the "accept either" rule. */
const XUEXI: EntrySnapshot = {
  ...DASUAN,
  simp: '学习',
  trad: '學習',
  pinyinMarked: 'xuéxí',
  pinyinNum: 'xue2 xi2',
  glosses: ['to learn', 'to study'],
  classifiers: [],
};

let made = 0;

function card(overrides: Partial<CardRow> = {}): CardRow {
  made += 1;
  const direction: CardDirection = overrides.direction ?? 'recognition';
  return {
    id: `card-${made}`,
    wordId: `word-${made}`,
    entryId: '打算|打算[da3 suan4]',
    kind: 'word',
    direction,
    snapshot: DASUAN,
    fsrs: {
      state: 2,
      due: 0,
      stability: 10,
      difficulty: 5,
      reps: 1,
      lapses: 0,
      scheduled_days: 1,
      learning_steps: 0,
    },
    due: 0,
    createdAt: made,
    updatedAt: made,
    deletedAt: null,
    ...overrides,
  };
}

describe('gradeProduction', () => {
  it('accepts the word itself, and says nothing that needs a model', () => {
    const judgement = gradeProduction({ typed: '打算', snapshot: DASUAN, script: 'simp' });
    expect(judgement.outcome).toBe('exact');
    expect(judgement.suggested).toBe(3);
    expect(judgement.askProvider).toBe(false);
  });

  it('ignores spacing and punctuation around the answer', () => {
    expect(gradeProduction({ typed: ' 打 算。', snapshot: DASUAN, script: 'simp' }).outcome).toBe(
      'exact',
    );
  });

  it('accepts the other script rather than marking it wrong', () => {
    // Set to simplified, wrote traditional. That is the word.
    const judgement = gradeProduction({ typed: '學習', snapshot: XUEXI, script: 'simp' });
    expect(judgement.outcome).toBe('other-script');
    expect(judgement.suggested).toBe(3);
    expect(judgement.why).toContain('traditional');
    // …and the same the other way round.
    const back = gradeProduction({ typed: '学习', snapshot: XUEXI, script: 'trad' });
    expect(back.outcome).toBe('other-script');
    expect(back.why).toContain('simplified');
  });

  it('counts the word inside a longer answer', () => {
    const judgement = gradeProduction({ typed: '我打算去', snapshot: DASUAN, script: 'simp' });
    expect(judgement.outcome).toBe('contains');
    expect(judgement.suggested).toBe(3);
    expect(judgement.askProvider).toBe(false);
  });

  it('does not accept the reading for the characters', () => {
    const judgement = gradeProduction({ typed: 'dasuan', snapshot: DASUAN, script: 'simp' });
    expect(judgement.outcome).toBe('no-hanzi');
    expect(judgement.suggested).toBe(1);
    expect(judgement.askProvider).toBe(false);
  });

  it('asks for a judgement only when one character is off', () => {
    const near = gradeProduction({ typed: '打筭', snapshot: DASUAN, script: 'simp' });
    expect(near.outcome).toBe('near');
    expect(near.suggested).toBe(2);
    expect(near.askProvider).toBe(true);

    // A different word is not a near miss, and costs no request.
    const wrong = gradeProduction({ typed: '计划', snapshot: DASUAN, script: 'simp' });
    expect(wrong.outcome).toBe('wrong');
    expect(wrong.suggested).toBe(1);
    expect(wrong.askProvider).toBe(false);
  });

  it('never calls a one-character answer to a one-character word "near"', () => {
    const single: EntrySnapshot = { ...DASUAN, simp: '看', trad: '看' };
    const judgement = gradeProduction({ typed: '着', snapshot: single, script: 'simp' });
    expect(judgement.outcome).toBe('wrong');
  });

  it('treats an empty answer as nothing written, not as a wrong word', () => {
    expect(gradeProduction({ typed: '   ', snapshot: DASUAN, script: 'simp' }).outcome).toBe(
      'empty',
    );
  });
});

describe('normalizeProduced', () => {
  it('folds width and case but keeps the characters', () => {
    expect(normalizeProduced('卡拉ＯＫ')).toBe(normalizeProduced('卡拉ok'));
    expect(normalizeProduced('打算')).toBe('打算');
  });
});

describe('editDistance', () => {
  it('counts characters, not code units', () => {
    expect(editDistance('打算', '打算')).toBe(0);
    expect(editDistance('打算', '打筭')).toBe(1);
    expect(editDistance('', '打算')).toBe(2);
  });
});

describe('what a production front may show', () => {
  it('blanks the headword out of a gloss, reading and all', () => {
    const masked = maskTargets('variant of 打算[da3 suan4]', ['打算']);
    expect(masked).not.toContain('打算');
    expect(masked).not.toContain('da3 suan4');
    expect(masked).toContain('variant of');
  });

  it('leaves a gloss that does not name the word alone', () => {
    expect(maskTargets('to plan', ['打算'])).toBe('to plan');
  });

  it('reports a line that still contains the answer', () => {
    expect(revealsTarget('我打算去', ['打算'])).toBe(true);
    expect(revealsTarget('我＿＿去', ['打算'])).toBe(false);
  });
});

describe('counting and ordering', () => {
  it('counts the two directions apart', () => {
    const counts = countByDirection([card(), card({ direction: 'production' }), card()]);
    expect(counts).toEqual({ recognition: 2, production: 1, total: 3 });
  });

  it('never offers a word twice in a row', () => {
    const first = card({ id: 'a', entryId: 'x' });
    const twin = card({ id: 'b', entryId: 'x', direction: 'production' });
    const other = card({ id: 'c', entryId: 'y' });
    expect(spaceDirections([first, twin, other]).map((row) => row.id)).toEqual(['a', 'c', 'b']);
  });

  it('keeps every card even when there is nothing to space with', () => {
    const first = card({ id: 'a', entryId: 'x' });
    const twin = card({ id: 'b', entryId: 'x', direction: 'production' });
    expect(spaceDirections([first, twin]).map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('lets the recognition card answer for a word that has both', () => {
    const recognition = card({ id: 'r' });
    const production = card({ id: 'p', direction: 'production' });
    expect(preferRecognition(undefined, production).id).toBe('p');
    expect(preferRecognition(production, recognition).id).toBe('r');
    expect(preferRecognition(recognition, production).id).toBe('r');
  });
});

describe('planning twins', () => {
  it('twins started recognition cards, up to the limit, and no further', () => {
    const cards = [
      card({ id: 'a', entryId: 'a' }),
      card({ id: 'b', entryId: 'b' }),
      card({ id: 'c', entryId: 'c' }),
    ];
    const plan = planProductionTwins({ cards, limit: 2 });
    expect(plan.create.map((row) => row.id)).toEqual(['a', 'b']);
    expect(plan.pending).toBe(1);
  });

  it('leaves a word that already has one alone', () => {
    const recognition = card({ id: 'a', entryId: 'a' });
    const twin = card({ id: 'a-p', entryId: 'a', direction: 'production' });
    expect(hasProductionTwin([recognition, twin], recognition)).toBe(true);
    expect(planProductionTwins({ cards: [recognition, twin], limit: 5 }).create).toEqual([]);
  });

  it('separates the senses: a card about sense 2 is its own question', () => {
    const first = card({ id: 'a', entryId: 'a', senseIndex: 0 });
    const second = card({ id: 'b', entryId: 'a', senseIndex: 1 });
    const twin = card({ id: 'a-p', entryId: 'a', senseIndex: 0, direction: 'production' });
    expect(twinKey(first)).not.toBe(twinKey(second));
    expect(planProductionTwins({ cards: [first, second, twin], limit: 5 }).create).toEqual([
      second,
    ]);
  });

  it('will not produce a word that has never been recognised', () => {
    const fresh = card({ id: 'new', fsrs: { ...card().fsrs, state: 0 } });
    expect(planProductionTwins({ cards: [fresh], limit: 5 }).create).toEqual([]);
    expect(
      planProductionTwins({ cards: [fresh], limit: 5, requireStarted: false }).create,
    ).toHaveLength(1);
  });

  it('follows the list order it is given', () => {
    const cards = [card({ id: 'a', entryId: 'a' }), card({ id: 'b', entryId: 'b' })];
    const plan = planProductionTwins({ cards, entryIds: ['b', 'a'], limit: 1 });
    expect(plan.create.map((row) => row.id)).toEqual(['b']);
  });

  it('ignores a tombstone and a phrase card', () => {
    const dead = card({ id: 'dead', entryId: 'dead', deletedAt: 1 });
    const phrase = card({
      id: 'phrase',
      entryId: null,
      kind: 'phrase',
      snapshot: {
        tokens: [{ text: '随便' }],
        simp: '随便看看',
        pinyinMarked: 'suíbiàn kànkan',
        en: 'just browsing',
        dictVersion: 'test',
      },
    });
    expect(planProductionTwins({ cards: [dead, phrase], limit: 5 }).create).toEqual([]);
  });
});

describe('the twin itself', () => {
  it('is cut from the card own snapshot, not from today dictionary', () => {
    const entry = entryFromSnapshot('打算|打算[da3 suan4]', DASUAN);
    expect(entry.id).toBe('打算|打算[da3 suan4]');
    expect(entry.simp).toBe('打算');
    expect(entry.glosses).toEqual(['to plan', 'to intend']);
    expect(entry.hskBand).toBe(2);
  });

  it('inherits the sentence, and can be re-sourced so the cap counts it', () => {
    const withContext = card({
      context: { sentence: '我打算明天去北京。', offset: 1, length: 2, source: 'reader', addedAt: 1 },
    });
    expect(twinContext(withContext, 99)?.source).toBe('reader');
    const asList = twinContext(withContext, 99, 'list');
    expect(asList?.source).toBe('list');
    expect(asList?.sentence).toBe('我打算明天去北京。');
    expect(asList?.addedAt).toBe(99);
    expect(twinContext(card({ context: undefined }), 99)).toBeUndefined();
  });
});

describe('productionRecallRequest', () => {
  const input = { entryId: '打算|打算[da3 suan4]', answer: '打算' };

  it('grades an exact answer without touching the provider', async () => {
    const provider = vi.fn(async () => {
      throw new Error('the provider must not be asked about an exact match');
    });
    const request = productionRecallRequest(card(), 'simp', provider);
    await expect(request(input)).resolves.toMatchObject({ suggested: 3 });
    expect(provider).not.toHaveBeenCalled();
  });

  it('grades a plainly wrong answer without touching the provider either', async () => {
    const provider = vi.fn(async () => null);
    const request = productionRecallRequest(card(), 'simp', provider);
    await expect(request({ ...input, answer: '计划' })).resolves.toMatchObject({ suggested: 1 });
    expect(provider).not.toHaveBeenCalled();
  });

  it('asks the provider about a near miss, and stands on its own reading if it fails', async () => {
    const answered = vi.fn(async () => ({ suggested: 2 as const, why: 'a judgement' }));
    const request = productionRecallRequest(card(), 'simp', answered);
    await expect(request({ ...input, answer: '打筭' })).resolves.toEqual({
      suggested: 2,
      why: 'a judgement',
    });
    expect(answered).toHaveBeenCalledTimes(1);

    const failed = vi.fn(async () => {
      throw new Error('offline');
    });
    const fallback = productionRecallRequest(card(), 'simp', failed);
    await expect(fallback({ ...input, answer: '打筭' })).resolves.toMatchObject({
      suggested: 2,
      why: 'One character off.',
    });

    const empty = productionRecallRequest(card(), 'simp', vi.fn(async () => null));
    await expect(empty({ ...input, answer: '打筭' })).resolves.toMatchObject({ suggested: 2 });
  });

  it('has nothing to say about a phrase card', async () => {
    const phrase = card({
      kind: 'phrase',
      entryId: null,
      snapshot: {
        tokens: [],
        simp: '随便看看',
        pinyinMarked: 'suíbiàn kànkan',
        en: 'just browsing',
        dictVersion: 'test',
      },
    });
    const request = productionRecallRequest(phrase, 'simp', vi.fn(async () => null));
    await expect(request(input)).resolves.toBeNull();
  });
});

describe('addProductionTwins', () => {
  it('creates nothing when the day has no allowance left', async () => {
    const repo = {
      getSettings: vi.fn(async () => ({ newPerDay: 0, dayRollover: 4, introduced: {} })),
      allCards: vi.fn(async () => [card()]),
      addCardFromEntry: vi.fn(),
      bumpIntroduced: vi.fn(),
    };
    const outcome = await addProductionTwins({
      // The repository seam, narrowed to what this call actually uses.
      repo: repo as unknown as Parameters<typeof addProductionTwins>[0]['repo'],
    });
    expect(outcome.limit).toBe(0);
    expect(outcome.created).toEqual([]);
    expect(outcome.pending).toBe(1);
    expect(repo.addCardFromEntry).not.toHaveBeenCalled();
    expect(repo.bumpIntroduced).not.toHaveBeenCalled();
  });
});
