/**
 * Grounding under attack (PLAN.md §3.4, §1 commitment 3).
 *
 * Every case here is a hostile — or merely careless — provider response that
 * the Phases 4–5 review found reaching the screen. They are the reviewer's own
 * evidence, kept executable: the dictionary is ground truth, so no hanzi and no
 * reading may arrive from anywhere else, and the "unverified" warning has to
 * stay rare enough to mean something.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ground,
  renderPhrase,
  scrubProse,
  stripCjk,
  stripPinyin,
  entryLookup,
  type RawAskResponse,
} from '@/lib/ai/ground';
import { requireDictData } from '../dict/data-required';
import { entriesFor, entryFor, groundContext } from './helpers';

beforeAll(requireDictData);

/** A response whose only content is the fields under test. */
function response(partial: Partial<RawAskResponse>): RawAskResponse {
  return { interpretation: '', matches: [], sayIt: [], notes: [], ...partial };
}

/** One phrase built out of the given headwords, each cited by id. */
function phraseOf(words: string[], en = 'test phrase', register = 'neutral'): RawAskResponse {
  return response({
    sayIt: [{ tokens: words.map((word) => ({ entryId: entryFor(word).id })), en, register }],
  });
}

describe('a phrase’s own prose is scrubbed too', () => {
  it('cannot smuggle hanzi or pinyin through `en` and `register`', () => {
    const context = groundContext(entriesFor('我', '随便', '看看'));
    const grounded = ground(
      phraseOf(['我', '随便', '看看'], '我随便看看 (wǒ suíbiān kànkan) — I am just looking', '口語 casual'),
      context,
    );

    const [phrase] = grounded.sayIt;
    expect(phrase.en).toBe('I am just looking');
    expect(phrase.register).toBe('casual');
    // Ids are the dictionary's own keys and carry hanzi by construction; the
    // prose is what must not.
    const prose = [phrase.en, phrase.register, grounded.interpretation, ...grounded.notes].join(' ');
    expect(prose).not.toMatch(/[一-鿿]/u);
    expect(prose).not.toContain('suíbiān');

    // And the same string is what a phrase card would keep on its back.
    const rendered = renderPhrase(phrase, entryLookup(entriesFor('我', '随便', '看看')));
    expect(rendered.en).toBe('I am just looking');
  });

  it('drops a phrase whose English was nothing but Chinese', () => {
    const context = groundContext(entriesFor('我', '随便', '看看'));
    expect(ground(phraseOf(['我', '随便', '看看'], '我随便看看', '口語'), context).sayIt).toEqual([]);
  });
});

describe('prose carries no readings', () => {
  it('takes tone-marked and numbered pinyin out of every prose field', () => {
    const dasuan = entryFor('打算');
    const grounded = ground(
      response({
        interpretation: 'Say suíbiān (随便), pronounced sui1 bian1.',
        matches: [{ entryId: dasuan.id, senseIndex: 0, whyThisOne: 'read it as suíbiān 随便' }],
        notes: ['看看 is kán kan', 'wǒ zhǐ shì kàn kan', 'The doubled verb is casual.'],
      }),
      groundContext([dasuan]),
    );

    expect(grounded.interpretation).toBe('Say, pronounced.');
    expect(grounded.matches[0].whyThisOne).toBe('read it as');
    // A note that was only a reading has nothing left to say and is dropped;
    // the one that said something in English survives untouched.
    expect(grounded.notes).toEqual(['The doubled verb is casual.']);
  });

  it('fires on the tone, not on English that happens to be a syllable', () => {
    expect(stripPinyin('The men can hang on to a long song about her.')).toBe(
      'The men can hang on to a long song about her.',
    );
    expect(stripPinyin('It is pronounced hěn hǎo.')).toBe('It is pronounced.');
    expect(stripPinyin('Written hen3 hao3 with numbers.')).toBe('Written with numbers.');
    // An untoned syllable next to a toned one goes with it — half a reading is
    // still a reading.
    expect(stripPinyin('is kán kan')).toBe('is');
  });

  it('leaves ordinary English prose alone', () => {
    const prose =
      'In a shop, the natural reply to an assistant is that you are only looking — not a translation of "browsing".';
    expect(scrubProse(prose)).toBe(prose);
  });
});

describe('the CJK strip covers the lookalikes', () => {
  it('takes out Bopomofo, Kangxi radicals and the extension planes', () => {
    // ⼀ (U+2F00) is not 一 (U+4E00) but renders identically.
    expect(stripCjk('the radical ⼀⽇ here')).toBe('the radical here');
    expect(stripCjk('zhuyin ㄨㄛˇ ㄎㄢˋ here')).toBe('zhuyin ˇ ˋ here');
    expect(stripCjk('supplement ⺀ here')).toBe('supplement here');
    expect(stripCjk('ext G 𰀀 here')).toBe('ext G here');
    expect(stripCjk('enclosed ㊣ 正 here')).toBe('enclosed here');
  });
});

describe('the unverified flag stays rare enough to mean something', () => {
  const everyday = ['太贵了', '我爱你', '我很累', '我饿了', '我很忙', '我先走了', '太热了', '我懂了'];

  it('leaves an everyday phrase built from cited words alone', () => {
    for (const phrase of everyday) {
      const characters = [...phrase];
      const context = groundContext(entriesFor(...characters));
      const grounded = ground(phraseOf(characters), context);
      expect(grounded.sayIt, phrase).toHaveLength(1);
      expect(grounded.sayIt[0].unverified, phrase).toBe(false);
    }
  });

  it('still flags the two inventions the plan names', () => {
    const suikan = ground(phraseOf(['随', '看', '随', '买']), groundContext(entriesFor('随', '看', '买')));
    expect(suikan.sayIt[0].unverified).toBe(true);

    const jue = ground(phraseOf(['绝', '绝', '子']), groundContext(entriesFor('绝', '子')));
    expect(jue.sayIt[0].unverified).toBe(true);
  });

  it('flags only the model’s own token when a phrase mixes the two', () => {
    const context = groundContext(entriesFor('我', '爱'));
    const grounded = ground(
      response({
        sayIt: [
          {
            tokens: [{ entryId: entryFor('我').id }, { text: '超爱' }, { entryId: entryFor('我').id }],
            en: 'I super love me',
            register: 'slang',
          },
        ],
      }),
      context,
    );

    const [first, invented, last] = grounded.sayIt[0].tokens;
    expect(invented).toMatchObject({ text: '超爱', aiGenerated: true, unverified: true });
    expect(first.unverified).toBeUndefined();
    expect(last.unverified).toBeUndefined();
  });
});

describe('polyphone means several readings, not several rows', () => {
  it('does not warn about a headword with one reading and many entries', () => {
    // 后/後/Hòu are three CC-CEDICT rows and one Mandarin reading.
    for (const word of ['后', '里', '面', '出']) {
      const context = groundContext(entriesFor(word));
      const [token] = ground(phraseOf([word]), context).sayIt[0].tokens;
      expect('polyphone' in token ? token.polyphone : undefined, word).toBeUndefined();
    }
  });

  it('still warns about a real polyphone', () => {
    for (const word of ['看', '发']) {
      const context = groundContext(entriesFor(word));
      const [token] = ground(phraseOf([word]), context).sayIt[0].tokens;
      expect('polyphone' in token ? token.polyphone : undefined, word).toBe(true);
    }
  });
});

describe('an answer is bounded', () => {
  it('caps notes and tokens, truncates prose and drops a duplicate match', () => {
    const dasuan = entryFor('打算');
    const wo = entryFor('我');
    const grounded = ground(
      response({
        interpretation: 'x'.repeat(50_000),
        matches: [
          { entryId: dasuan.id, senseIndex: 0, whyThisOne: 'first' },
          { entryId: dasuan.id, senseIndex: 0, whyThisOne: 'the same sense again' },
          { entryId: dasuan.id, senseIndex: 1, whyThisOne: 'a different sense' },
        ],
        sayIt: [
          {
            tokens: Array.from({ length: 5_000 }, () => ({ entryId: wo.id })),
            en: 'me '.repeat(5_000),
            register: 'neutral',
          },
        ],
        notes: Array.from({ length: 10_000 }, (_, index) => `note number ${index}`),
      }),
      groundContext([dasuan, wo]),
    );

    expect(grounded.interpretation.length).toBeLessThanOrEqual(2_000);
    expect(grounded.matches).toHaveLength(2);
    expect(grounded.sayIt[0].tokens.length).toBeLessThanOrEqual(32);
    expect(grounded.sayIt[0].en.length).toBeLessThanOrEqual(2_000);
    expect(grounded.notes).toHaveLength(8);
  });
});
