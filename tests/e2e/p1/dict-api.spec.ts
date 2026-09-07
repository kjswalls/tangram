import { expect, test } from '@playwright/test';

/**
 * The Phase 1 dictionary routes over real HTTP (PLAN.md §3.2). The ranking itself
 * is unit-tested against the data; what is proved here is that the routes carry it
 * across the wire — including the shapes the reader and the ask panel will parse.
 */

interface Group {
  key: string;
  simp: string;
  trad: string;
  source: 'hanzi' | 'pinyin' | 'english';
  matchedIds: string[];
  entries: { id: string; pinyinMarked: string; hskBand?: number; classifiers: string[] }[];
  hskBand?: number;
}

interface SearchBody {
  query: string;
  route: string;
  groups: Group[];
  sections: { source: string; label: string; groups: Group[] }[];
  total: number;
  offset: number;
  nextCursor?: string;
  dictVersion: string;
}

interface Token {
  text: string;
  start: number;
  end: number;
  kind: 'word' | 'text';
  entryIds: string[];
  via: 'entry' | 'fallback';
}

test.describe('GET /api/dict/search', () => {
  test('answers a pinyin query with the word first, grouped and banded', async ({ request }) => {
    const res = await request.get('/api/dict/search?q=dasuan');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.route).toBe('pinyin+english');
    expect(body.groups[0].simp).toBe('打算');
    expect(body.groups[0].hskBand).toBe(2);
    expect(body.groups[0].source).toBe('pinyin');
    expect(body.groups[0].entries[0].pinyinMarked).toBe('dǎsuàn');
    expect(body.dictVersion).toMatch(/\d/);
  });

  test('answers hanzi, traditional included, and groups a polyphone', async ({ request }) => {
    const trad = await request.get(`/api/dict/search?q=${encodeURIComponent('學習')}`);
    expect(((await trad.json()) as SearchBody).groups[0].simp).toBe('学习');

    const le = await request.get(`/api/dict/search?q=${encodeURIComponent('了')}`);
    const group = ((await le.json()) as SearchBody).groups[0];
    const readings = group.entries.map((entry) => entry.pinyinMarked);
    expect(readings).toContain('le');
    expect(readings).toContain('liǎo');
  });

  test('labels the sections when a query is both pinyin and English', async ({ request }) => {
    const res = await request.get('/api/dict/search?q=sun');
    const body = (await res.json()) as SearchBody;
    expect(body.sections.map((section) => section.source)).toEqual(['english', 'pinyin']);
    expect(body.groups.map((group) => group.simp)).toContain('太阳');
    expect(body.groups.map((group) => group.simp)).toContain('孙');
  });

  test('caps a page and pages on with the cursor', async ({ request }) => {
    const first = (await (await request.get('/api/dict/search?q=yi')).json()) as SearchBody;
    expect(first.groups.length).toBeLessThanOrEqual(50);
    expect(first.total).toBeGreaterThan(50);
    expect(first.nextCursor).toBeTruthy();

    const second = (await (
      await request.get(`/api/dict/search?q=yi&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)
    ).json()) as SearchBody;
    const seen = new Set(first.groups.map((group) => group.key));
    expect(second.groups.some((group) => seen.has(group.key))).toBe(false);
  });

  test('rejects a missing query', async ({ request }) => {
    expect((await request.get('/api/dict/search')).status()).toBe(400);
    expect((await request.get('/api/dict/search?q=%20')).status()).toBe(400);
  });
});

test.describe('POST /api/dict/segment', () => {
  test('cuts a sentence and keeps every reading on the token', async ({ request }) => {
    const res = await request.post('/api/dict/segment', { data: { text: '我打算明天去北京' } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { script: string; tokens: Token[] };
    expect(body.script).toBe('simp');
    expect(body.tokens.map((token) => token.text)).toEqual(['我', '打算', '明天', '去', '北京']);
    expect(body.tokens.every((token) => token.kind === 'word')).toBe(true);
  });

  test('leaves punctuation as text and gives 了 both readings', async ({ request }) => {
    const res = await request.post('/api/dict/segment', { data: { text: '我想了一下。你好吗？' } });
    const { tokens } = (await res.json()) as { tokens: Token[] };
    const le = tokens.find((token) => token.text === '了');
    expect(le?.entryIds.length).toBeGreaterThanOrEqual(2);
    const punctuation = tokens.filter((token) => token.kind === 'text');
    expect(punctuation.map((token) => token.text)).toEqual(['。', '？']);
    expect(punctuation.every((token) => token.entryIds.length === 0)).toBe(true);
  });

  test('rejects a body without text', async ({ request }) => {
    expect((await request.post('/api/dict/segment', { data: {} })).status()).toBe(400);
  });
});

test('GET /api/dict/decomp breaks a character into its parts', async ({ request }) => {
  const res = await request.get(`/api/dict/decomp?chars=${encodeURIComponent('打算')}`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    characters: { char: string; entry: { decomposition: string; radical: string } | null }[];
  };
  expect(body.characters.map((character) => character.char)).toEqual(['打', '算']);
  expect(body.characters[0].entry?.radical).toBe('扌');
  expect(body.characters[0].entry?.decomposition).toContain('扌');
});
