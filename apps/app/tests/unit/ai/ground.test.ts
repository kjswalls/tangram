/**
 * Grounding (PLAN.md §3.4, step 3). The four cases the plan names are here:
 * 随看随买 and 绝绝子 come back with unverified tokens, 我随便看看 does not, an
 * injected `'bogus'` id is dropped, and a response carrying a wrong pinyin
 * cannot change what is displayed.
 *
 * `attacks.test.ts` beside this file is the other half: the hostile responses
 * the Phases 4–5 review found reaching the screen, including the everyday
 * phrases (太贵了, 我爱你, 我很累) that must *not* be flagged.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  entryLookup,
  ground,
  renderPhrase,
  stripCjk,
  unverifiedSpans,
  type RawAskResponse,
} from '@/lib/ai/ground';
import { requireDictData } from '../dict/data-required';
import { entriesFor, entryFor, groundContext, readingOf } from './helpers';

beforeAll(requireDictData);

/** A response that says one phrase, built out of the given headwords. */
function phraseResponse(words: string[]): RawAskResponse {
  return {
    interpretation: 'plain prose',
    matches: [],
    sayIt: [
      {
        tokens: words.map((word) => ({ entryId: entryFor(word).id })),
        en: 'test phrase',
        register: 'neutral',
      },
    ],
    notes: [],
  };
}

describe('unverified tokens', () => {
  it('leaves a phrase made of real words alone (我随便看看)', () => {
    const context = groundContext(entriesFor('我', '随便', '看看'));
    const grounded = ground(phraseResponse(['我', '随便', '看看']), context);

    expect(grounded.sayIt).toHaveLength(1);
    expect(grounded.sayIt[0].unverified).toBe(false);
    expect(grounded.sayIt[0].tokens.every((token) => token.unverified === undefined)).toBe(true);
    expect(unverifiedSpans('我随便看看', context)).toEqual([]);
  });

  it('flags a string of characters that is not a word (随看随买)', () => {
    const context = groundContext(entriesFor('随', '看', '买'));
    const grounded = ground(phraseResponse(['随', '看', '随', '买']), context);

    expect(grounded.sayIt).toHaveLength(1);
    expect(grounded.sayIt[0].unverified).toBe(true);
    expect(grounded.sayIt[0].tokens.every((token) => token.unverified === true)).toBe(true);
  });

  it('flags an invented slang compound (绝绝子)', () => {
    const context = groundContext(entriesFor('绝', '子'));
    const grounded = ground(phraseResponse(['绝', '绝', '子']), context);

    expect(grounded.sayIt[0].unverified).toBe(true);
    expect(grounded.sayIt[0].tokens.filter((token) => token.unverified).length).toBeGreaterThanOrEqual(2);
  });

  it('does not flag an ordinary run of grammatical single characters (我看了一下)', () => {
    // 我 (rank 8), 看 (81) and 了 (1) are among the most frequent words there
    // are; a sentence is not an invented compound just because it contains them.
    const context = groundContext(entriesFor('我', '看', '了', '一下'));
    expect(unverifiedSpans('我看了一下', context)).toEqual([]);
  });

  it('flags a hanzi the dictionary does not have at all', () => {
    const context = groundContext(entriesFor('我'));
    // 𠮷 is a rare variant that is not a CC-CEDICT headword: `via: 'fallback'`.
    expect(unverifiedSpans('𠮷', context).length).toBeGreaterThan(0);
  });

  it('marks the model’s own text token as AI-generated and unverified', () => {
    const context = groundContext(entriesFor('我'));
    const grounded = ground(
      {
        interpretation: '',
        matches: [],
        sayIt: [
          {
            tokens: [{ entryId: entryFor('我').id }, { text: 'blorp' }],
            en: 'made up',
            register: 'neutral',
          },
        ],
        notes: [],
      },
      context,
    );

    const [first, second] = grounded.sayIt[0].tokens;
    expect(first.unverified).toBeUndefined();
    expect(second).toMatchObject({ text: 'blorp', aiGenerated: true, unverified: true });
    expect(grounded.sayIt[0].unverified).toBe(true);
  });
});

describe('citations', () => {
  it('drops a match whose id was never retrieved', () => {
    const dasuan = entryFor('打算');
    const context = groundContext([dasuan]);
    const grounded = ground(
      {
        interpretation: '',
        matches: [
          { entryId: 'bogus', senseIndex: 0, whyThisOne: 'invented' },
          { entryId: dasuan.id, senseIndex: 1, whyThisOne: 'real' },
        ],
        sayIt: [],
        notes: [],
      },
      context,
    );

    expect(grounded.matches).toEqual([
      { entryId: dasuan.id, senseIndex: 1, whyThisOne: 'real' },
    ]);
  });

  it('drops a match whose senseIndex is past the end of the entry', () => {
    const dasuan = entryFor('打算');
    const grounded = ground(
      {
        interpretation: '',
        matches: [{ entryId: dasuan.id, senseIndex: dasuan.glosses.length, whyThisOne: 'off the end' }],
        sayIt: [],
        notes: [],
      },
      groundContext([dasuan]),
    );
    expect(grounded.matches).toEqual([]);
  });

  it('discards a whole phrase that cites an id outside the retrieved set', () => {
    const grounded = ground(
      {
        interpretation: '',
        matches: [],
        sayIt: [
          {
            tokens: [{ entryId: entryFor('我').id }, { entryId: 'bogus' }],
            en: 'half real',
            register: 'neutral',
          },
        ],
        notes: [],
      },
      groundContext(entriesFor('我')),
    );
    // A hole in the middle of a sentence teaches nothing, so the phrase goes.
    expect(grounded.sayIt).toEqual([]);
  });

  it('flags a cited polyphone so the UI can warn before an Add', () => {
    const kan4 = readingOf('看', 'kan4');
    const grounded = ground(
      {
        interpretation: '',
        matches: [],
        sayIt: [{ tokens: [{ entryId: kan4.id }], en: 'look', register: 'neutral' }],
        notes: [],
      },
      groundContext(entriesFor('看')),
    );
    expect(grounded.sayIt[0].tokens[0]).toMatchObject({ entryId: kan4.id, polyphone: true });
  });
});

describe('rendering is the dictionary’s, not the model’s', () => {
  it('a wrong pinyin in the response cannot change what is displayed', () => {
    const dasuan = entryFor('打算');
    // The model claims a reading and a headword on the token. Neither is part
    // of the validated shape, and neither reaches the screen.
    const hostile = {
      interpretation: '',
      matches: [],
      sayIt: [
        {
          tokens: [{ entryId: dasuan.id, text: '打祘', pinyinMarked: 'dàsuān' }],
          en: 'to plan',
          register: 'neutral',
        },
      ],
      notes: [],
    } as unknown as RawAskResponse;

    const grounded = ground(hostile, groundContext([dasuan]));
    const rendered = renderPhrase(grounded.sayIt[0], entryLookup([dasuan]));

    expect(rendered.zh).toBe(dasuan.simp);
    expect(rendered.pinyin).toBe(dasuan.pinyinMarked);
    expect(rendered.pinyin).not.toContain('dàsuān');
    expect(JSON.stringify(grounded)).not.toContain('打祘');
  });

  it('renders a missing entry as missing rather than as text', () => {
    const rendered = renderPhrase(
      { tokens: [{ entryId: 'gone' }], en: 'x', register: 'y' },
      entryLookup([]),
    );
    expect(rendered.tokens[0]).toMatchObject({ text: '', missing: true });
    expect(rendered.unverified).toBe(true);
  });
});

describe('prose carries no CJK', () => {
  it('strips runs and tidies what they leave behind', () => {
    expect(stripCjk('The word 随便 means casual.')).toBe('The word means casual.');
    expect(stripCjk('Say “我随便看看” to a shop assistant.')).toBe('Say to a shop assistant.');
    expect(stripCjk('no chinese here')).toBe('no chinese here');
  });

  it('strips the interpretation, the notes and every whyThisOne', () => {
    const dasuan = entryFor('打算');
    const grounded = ground(
      {
        interpretation: 'The verb 打算 is the one you want.',
        matches: [{ entryId: dasuan.id, senseIndex: 0, whyThisOne: 'Unlike 计划, it is spoken.' }],
        sayIt: [],
        notes: ['A note about 打算.', '打算'],
      },
      groundContext([dasuan]),
    );

    expect(grounded.interpretation).toBe('The verb is the one you want.');
    expect(grounded.matches[0].whyThisOne).toBe('Unlike, it is spoken.');
    // A note that was nothing but hanzi has nothing left to say.
    expect(grounded.notes).toEqual(['A note about.']);
  });
});
