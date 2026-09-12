/**
 * `lib/dict/resolve.ts` and `POST /api/dict/resolve`, against the real generated
 * dictionary: the importer's exact-hanzi-then-pinyin rule.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { POST as resolvePost } from '@/app/api/dict/resolve/route';
import { dictVersion, getDictIndex } from '@/lib/dict/index';
import { RESOLVE_MAX_WORDS, resolveWord, resolveWords, type ResolveResult } from '@/lib/dict/resolve';
import { requireDictData } from './data-required';

const NIHAO = '你好|你好[ni3 hao3]';
const DASUAN = '打算|打算[da3 suan4]';

function request(body: unknown): Request {
  return new Request('http://localhost/api/dict/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('resolveWord', () => {
  beforeAll(requireDictData);

  it('matches hanzi exactly, never by prefix', () => {
    const index = getDictIndex();
    expect(resolveWord(index, '你好')).toMatchObject({ via: 'hanzi' });
    expect(resolveWord(index, '你好').entries.map((entry) => entry.id)).toContain(NIHAO);
    // 打 alone has its own entries; 打算 is a prefix match and must not appear.
    const da = resolveWord(index, '打');
    expect(da.entries.every((entry) => entry.simp === '打' || entry.trad === '打')).toBe(true);
    expect(da.entries.map((entry) => entry.id)).not.toContain(DASUAN);
  });

  it('matches either script', () => {
    const index = getDictIndex();
    const simp = resolveWord(index, '学习');
    const trad = resolveWord(index, '學習');
    expect(simp.via).toBe('hanzi');
    expect(trad.via).toBe('hanzi');
    expect(simp.entries.map((entry) => entry.id)).toEqual(trad.entries.map((entry) => entry.id));
  });

  it('returns every reading of a polyphone, most frequent first', () => {
    const readings = resolveWord(getDictIndex(), '了').entries.map((entry) => entry.pinyinNum);
    expect(new Set(readings).size).toBeGreaterThan(1);
    expect(readings[0]).toBe('le5');
    expect(readings).toContain('liao3');
  });

  it('falls back to pinyin: tone-exact, then toneless', () => {
    const index = getDictIndex();
    for (const spelling of ['dǎsuàn', 'da3suan4', 'da3 suan4', 'dasuan']) {
      const got = resolveWord(index, spelling);
      expect(got.via, spelling).toBe('pinyin');
      expect(got.entries.map((entry) => entry.id), spelling).toContain(DASUAN);
    }
    // Tones narrow: `da3suan4` is only 打算; `dasuan` may carry more headwords.
    expect(resolveWord(index, 'da3suan4').entries.every((entry) => entry.pinyinNum === 'da3 suan4')).toBe(true);
  });

  it('answers a toneless syllable with every headword read that way', () => {
    const simps = resolveWord(getDictIndex(), 'le').entries.map((entry) => entry.simp);
    expect(simps).toContain('了');
    expect(simps).toContain('乐');
  });

  it('matches nothing for English, junk or an empty word', () => {
    const index = getDictIndex();
    expect(resolveWord(index, 'hello')).toMatchObject({ via: 'none', entries: [] });
    expect(resolveWord(index, 'xyzzyq')).toMatchObject({ via: 'none', entries: [] });
    expect(resolveWord(index, '   ')).toMatchObject({ via: 'none', entries: [] });
    expect(resolveWord(index, '你好吗吗吗')).toMatchObject({ via: 'none', entries: [] });
  });
});

describe('POST /api/dict/resolve', () => {
  beforeAll(requireDictData);

  it('resolves every word in order and names the snapshot', async () => {
    const res = await resolvePost(request({ words: ['你好', 'xyzzyq', 'le'] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResolveResult;
    expect(body.dictVersion).toBe(dictVersion());
    expect(body.results.map((row) => row.word)).toEqual(['你好', 'xyzzyq', 'le']);
    expect(body.results.map((row) => row.via)).toEqual(['hanzi', 'none', 'pinyin']);
    expect(body.results[0].entries[0].id).toBe(NIHAO);
    expect(body.results).toEqual(resolveWords(['你好', 'xyzzyq', 'le']).results);
  });

  it('rejects a body that is not { words: string[] }', async () => {
    expect((await resolvePost(request('not json'))).status).toBe(400);
    expect((await resolvePost(request({}))).status).toBe(400);
    expect((await resolvePost(request({ words: [] }))).status).toBe(400);
    expect((await resolvePost(request({ words: [1] }))).status).toBe(400);
    expect((await resolvePost(request({ words: ['x'.repeat(201)] }))).status).toBe(400);
  });

  it('caps the batch', async () => {
    const res = await resolvePost(request({ words: Array.from({ length: RESOLVE_MAX_WORDS + 1 }, () => '你') }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('too-many-words');
  });
});
