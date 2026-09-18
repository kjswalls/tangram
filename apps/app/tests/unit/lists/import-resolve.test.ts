/**
 * The importer's preview and plan (`lib/lists/import/resolve.ts`), over a
 * hand-built resolver: reading options, the default reading, the pinyin hint,
 * the `simp[trad]` filter, and the skip rules that feed one `addListMembers`.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedWord } from '@/lib/dict/store';
import { RESOLVE_MAX_WORDS } from '@/lib/dict/resolve';
import { parseImport, parsePlain } from '@/lib/lists/import/parse';
import {
  buildPreview,
  optionForReading,
  optionKey,
  optionsFor,
  planImport,
  RESOLVE_CHUNK,
  type Resolver,
} from '@/lib/lists/import/resolve';
import type { Entry } from '@/lib/types';

import { entry } from './helpers';

const LE = entry({ id: '了|了[le5]', simp: '了', trad: '了', pinyinNum: 'le5', pinyinMarked: 'le', freq: 900, glosses: ['(modal particle)'] });
const LIAO = entry({ id: '了|了[liao3]', simp: '了', trad: '了', pinyinNum: 'liao3', pinyinMarked: 'liǎo', freq: 900, glosses: ['to finish'] });
/**
 * 瞭 is a **different headword** read `liao3`, not a variant of 了 — CC-CEDICT
 * glosses it "(of eyes) bright; clear-sighted" and carries `is_variant = 0`.
 * The fixture used to be called `LIAO_VARIANT`, which is what made the old
 * `simp|toned` option key look harmless: folding it away read as tidying up
 * bookkeeping when it was losing a word. See `optionKey`'s comment.
 */
const LIAO_BRIGHT = entry({ id: '瞭|了[liao3]', simp: '了', trad: '瞭', pinyinNum: 'liao3', pinyinMarked: 'liǎo', freq: 900, glosses: ['(of eyes) bright'] });
/** And this one really is one: `是` under an old form nobody should be asked to choose. */
const LIAO_VARIANT = entry({ id: '瞭|了[liao3]x', simp: '了', trad: '瞭x', pinyinNum: 'liao3', pinyinMarked: 'liǎo', isVariant: true, freq: 900, glosses: ['variant of 瞭|了[liao3]'] });
const NIHAO = entry({ id: '你好|你好[ni3 hao3]', simp: '你好', trad: '你好', pinyinNum: 'ni3 hao3', pinyinMarked: 'nǐhǎo', glosses: ['hello'] });
const XUEXI = entry({ id: '學習|学习[xue2 xi2]', simp: '学习', trad: '學習', pinyinNum: 'xue2 xi2', pinyinMarked: 'xuéxí', glosses: ['to study'] });
const XUEXI_OTHER = entry({ id: '学习|学习[xue2 xi2]', simp: '学习', trad: '学习', pinyinNum: 'xue2 xi2', pinyinMarked: 'xuéxí', glosses: ['variant'] });
const YUE = entry({ id: '樂|乐[le4]', simp: '乐', trad: '樂', pinyinNum: 'le4', pinyinMarked: 'lè', glosses: ['happy'] });

const DICT: Record<string, { via: ResolvedWord['via']; entries: Entry[] }> = {
  了: { via: 'hanzi', entries: [LE, LIAO, LIAO_BRIGHT, LIAO_VARIANT] },
  你好: { via: 'hanzi', entries: [NIHAO] },
  学习: { via: 'hanzi', entries: [XUEXI, XUEXI_OTHER] },
  學習: { via: 'hanzi', entries: [XUEXI] },
  le: { via: 'pinyin', entries: [LE, YUE] },
  nihao: { via: 'pinyin', entries: [NIHAO] },
};

const fakeResolver: Resolver = async (words) => ({
  dictVersion: 'test-snapshot',
  results: words.map((word) => ({ word, ...(DICT[word] ?? { via: 'none', entries: [] }) })),
});

describe('optionsFor', () => {
  /**
   * One option per *word under one reading*, most frequent first. 了 `liao3`
   * and 瞭 `liao3` are two words and stay two options — the fold that used to
   * merge them is what made 面 mean only "face" with no picker to say
   * otherwise (`optionKey`).
   */
  it('lists one option per word and reading, most frequent first', () => {
    const options = optionsFor([LE, LIAO, LIAO_BRIGHT]);
    expect(options.map((option) => option.key)).toEqual(['了|了|le', '了|了|liao3', '了|瞭|liao3']);
    expect(options[1].entry.id).toBe(LIAO.id);
    expect(options[2].entry.id).toBe(LIAO_BRIGHT.id);
  });

  it('drops a variant that a real headword already covers', () => {
    // 瞭x is CC-CEDICT bookkeeping — "variant of 瞭|了[liao3]" — and asking the
    // learner to choose between a word and a cross-reference to it is the fold
    // `optionKey`'s old comment claimed to be doing.
    expect(optionsFor([LE, LIAO, LIAO_BRIGHT, LIAO_VARIANT]).map((o) => o.entry.id)).toEqual([
      LE.id,
      LIAO.id,
      LIAO_BRIGHT.id,
    ]);
  });

  it('keeps a word that exists ONLY as a variant, rather than losing it', () => {
    // Dropping unconditionally would resolve this row to nothing at all.
    expect(optionsFor([LIAO_VARIANT]).map((option) => option.entry.id)).toEqual([
      LIAO_VARIANT.id,
    ]);
  });

  it('keys by headword too, so 了 and 乐 stay apart', () => {
    expect(optionsFor([LE, YUE]).map((option) => option.key)).toEqual(['了|了|le', '乐|樂|le4']);
    expect(optionKey(YUE)).toBe('乐|樂|le4');
  });

  it('narrows to the other script from a simp[trad] headword, unless that leaves nothing', () => {
    expect(optionsFor([XUEXI, XUEXI_OTHER], '學習').map((option) => option.entry.id)).toEqual([XUEXI.id]);
    // With no candidate spelling the `alt`, the pool is everything — and the
    // two traditional headwords are two options, not one.
    expect(optionsFor([XUEXI, XUEXI_OTHER], '不在').map((option) => option.entry.id)).toEqual([
      XUEXI.id,
      XUEXI_OTHER.id,
    ]);
  });
});

describe('optionForReading', () => {
  const options = optionsFor([LE, LIAO]);

  it('picks the reading the row named, tone-exact or toneless', () => {
    expect(optionForReading(options, 'liǎo')?.key).toBe('了|了|liao3');
    expect(optionForReading(options, 'liao3')?.key).toBe('了|了|liao3');
    expect(optionForReading(options, 'liao')?.key).toBe('了|了|liao3');
    expect(optionForReading(options, 'le')?.key).toBe('了|了|le');
  });

  it('gives up rather than guess when the hint names no option', () => {
    expect(optionForReading(options, 'liao4')).toBeUndefined();
    expect(optionForReading(options, 'hello')).toBeUndefined();
    expect(optionForReading(options, undefined)).toBeUndefined();
  });
});

describe('buildPreview', () => {
  it('resolves every row and defaults a polyphone to its most frequent reading', async () => {
    const preview = await buildPreview(parsePlain('你好\n了\nxyzzyq'), fakeResolver);
    expect(preview.rows.map((row) => row.via)).toEqual(['hanzi', 'hanzi', 'none']);
    expect(preview.rows[1].options).toHaveLength(3);
    expect(preview.rows[1].defaultKey).toBe('了|了|le');
    expect(preview.rows[2].options).toEqual([]);
    expect(preview.rows[2].defaultKey).toBeUndefined();
  });

  it('lets a Pleco row’s own pinyin pick the reading', async () => {
    const preview = await buildPreview(parseImport('了\tliǎo\tto finish\n你好\tnǐhǎo\thello'), fakeResolver);
    expect(preview.format).toBe('pleco');
    expect(preview.rows[0].defaultKey).toBe('了|了|liao3');
    expect(preview.rows[1].defaultKey).toBe('你好|你好|ni3hao3');
  });

  it('resolves pinyin rows to every headword read that way', async () => {
    const preview = await buildPreview(parsePlain('le\nnihao'), fakeResolver);
    expect(preview.rows[0].via).toBe('pinyin');
    expect(preview.rows[0].options.map((option) => option.key)).toEqual(['了|了|le', '乐|樂|le4']);
    expect(preview.rows[1].defaultKey).toBe('你好|你好|ni3hao3');
  });

  it('sends each distinct word once, in chunks', async () => {
    const resolver = vi.fn(fakeResolver);
    // Distinct characters: the cleaner keeps a cell's hanzi run, so `词0`, `词1`… would all be 词.
    const lines = Array.from({ length: RESOLVE_CHUNK + 5 }, (_, i) => String.fromCharCode(0x4f00 + i)).concat(['了', '了']);
    await buildPreview(parsePlain(lines.join('\n')), resolver);
    expect(resolver).toHaveBeenCalledTimes(2);
    const sent = resolver.mock.calls.flatMap(([words]) => words);
    expect(sent).toHaveLength(RESOLVE_CHUNK + 6);
    expect(sent.filter((word) => word === '了')).toHaveLength(1);
  });
});

describe('planImport', () => {
  it('adds matched rows once, skipping what the list has and what an earlier row chose', async () => {
    const preview = await buildPreview(parsePlain('你好\n了\nle\nxyzzyq\n你好'), fakeResolver);
    const plan = planImport(preview, {}, new Set([NIHAO.id]));
    expect(plan.rows.map((row) => row.status)).toEqual([
      'present',
      'add',
      'duplicate', // `le` defaults to 了 le, which row 2 already took
      'unmatched',
      'present',
    ]);
    expect(plan.entryIds).toEqual([LE.id]);
    expect(plan.counts).toEqual({ add: 1, present: 2, duplicate: 1, unmatched: 1 });
  });

  it('follows the learner’s picks', async () => {
    const preview = await buildPreview(parsePlain('了\nle'), fakeResolver);
    const plan = planImport(preview, { 0: '了|了|liao3', 1: '乐|樂|le4' }, new Set());
    expect(plan.entryIds).toEqual([LIAO.id, YUE.id]);
    // An unknown key falls back to the row's first option rather than dropping the row.
    expect(planImport(preview, { 0: 'nonsense' }, new Set()).entryIds[0]).toBe(LE.id);
  });
});

describe('the chunk and the store’s cap', () => {
  /**
   * `DictStore.resolve` **rejects** past `RESOLVE_MAX_WORDS` rather than
   * truncating (`wave-zero.md` §8b), so a chunk that drifted above it would
   * turn a large Pleco export from a slow import into a failed one. The two
   * numbers live in different modules; this is what keeps them in relation.
   */
  it('never asks the store for more than it takes', () => {
    expect(RESOLVE_CHUNK).toBeLessThanOrEqual(RESOLVE_MAX_WORDS);
  });

  it('carries the dictionary version the answer named', async () => {
    // `abe6793` hard-coded `dictVersion: ''` here and dropped the route's
    // answer on the floor. A preview that cannot name its snapshot cannot say
    // which dictionary a list was resolved against.
    const preview = await buildPreview(parsePlain('你好'), fakeResolver);
    expect(preview.dictVersion).toBe('test-snapshot');
  });
});
