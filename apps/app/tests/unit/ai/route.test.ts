// @vitest-environment node
/**
 * `/api/ask`, exercised by calling the handlers with a Request (the pattern the
 * Phase 0 dictionary route tests set).
 *
 * This is the pipeline of §3.4 end to end on the real dictionary: search,
 * proposed phrases, segmentation, the union, the answer, the grounding, and the
 * entries that come back for rendering.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET, POST, mergeRetrieved, needsProposals, RETRIEVED_CAP, SEARCH_HEAD } from '@/app/api/ask/route';
import type { AskRouteInfo, AskRouteResponse } from '@/app/api/ask/route';
import { ASK_PROMPT_VERSION } from '@/lib/ai/cache-key';
import { resetDictCache } from '@/lib/dict/load';
import { requireDictData } from '../dict/data-required';
import { entriesFor, entryFor } from './helpers';

beforeAll(requireDictData);

const PROFILE = { estimatedBand: 2, knownSample: ['我', '是'] };

function ask(body: unknown): Request {
  return new Request('http://localhost/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown): Promise<{ status: number; body: AskRouteResponse }> {
  const res = await POST(ask(body));
  return { status: res.status, body: (await res.json()) as AskRouteResponse };
}

describe('GET /api/ask', () => {
  it('reports the provider and the prompt version the client needs for the cache key', async () => {
    const res = GET(new Request('http://localhost/api/ask'));
    expect(res.status).toBe(200);
    const info = (await res.json()) as AskRouteInfo;
    // No key in this container, so the fake answers — and says so.
    expect(info).toEqual({ provider: 'fake', promptVersion: ASK_PROMPT_VERSION });
  });
});

describe('the demo query', () => {
  it('renders at least one surviving match and one sayIt after validation', async () => {
    const { status, body } = await post({
      query: "how do I say I'm just browsing",
      profile: PROFILE,
    });

    expect(status).toBe(200);
    expect(body.provider).toBe('fake');
    expect(body.response.matches.length).toBeGreaterThanOrEqual(1);
    expect(body.response.sayIt.length).toBeGreaterThanOrEqual(1);

    // Retrieval reached the words the answer is built from, through
    // proposePhrases → segment → union, not through the gloss index: an English
    // sentence matches no gloss as a whole.
    const ids = new Set(body.entries.map((entry) => entry.id));
    for (const token of body.response.sayIt[0].tokens) {
      if (token.entryId) expect(ids.has(token.entryId)).toBe(true);
    }
    expect(ids.has(entryFor('随便').id)).toBe(true);

    // Every entry needed to draw the answer travels with it.
    expect(body.entries.every((entry) => entry.simp && entry.pinyinMarked !== undefined)).toBe(true);
    expect(body.dictVersion).toBeTruthy();
    expect(body.response.interpretation).not.toMatch(/[一-鿿]/);
  });

  it('answers a hanzi query differently depending on the sentence it came from', async () => {
    const looked = await post({ query: '看', context: { sentence: '我看了一下' }, profile: PROFILE });
    const after = await post({ query: '看', context: { sentence: '你看着孩子' }, profile: PROFILE });

    expect(looked.body.response.matches[0].entryId).not.toBe(after.body.response.matches[0].entryId);
    const chosen = (body: AskRouteResponse) =>
      body.response.matches.map((match) => `${match.entryId}#${match.senseIndex}`);
    expect(chosen(looked.body)).not.toEqual(chosen(after.body));
  });

  it('never renders an empty panel, whatever is typed', async () => {
    for (const query of ['dasuan', 'zzzqqq', 'how do I ask for the bill', '开始']) {
      const { body } = await post({ query, profile: PROFILE });
      expect(body.response.interpretation.length).toBeGreaterThan(0);
      const hasSomething =
        body.response.matches.length > 0 ||
        body.response.sayIt.length > 0 ||
        body.response.notes.length > 0;
      expect(hasSomething).toBe(true);
    }
  });
});

describe('the request contract', () => {
  it('rejects a body with no query', async () => {
    expect((await POST(ask({ profile: PROFILE }))).status).toBe(400);
    expect((await POST(ask({ query: '   ', profile: PROFILE }))).status).toBe(400);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('survives a missing profile rather than failing the ask', async () => {
    const { status, body } = await post({ query: 'dasuan' });
    expect(status).toBe(200);
    expect(body.response.matches.length).toBeGreaterThan(0);
  });
});

describe('retrieval', () => {
  it('asks for proposals only when the dictionary cannot answer alone', () => {
    expect(needsProposals('how do I say I am just browsing')).toBe(true);
    expect(needsProposals('dasuan')).toBe(true);
    expect(needsProposals('打算')).toBe(false);
    expect(needsProposals('看')).toBe(false);
    // A whole sentence of hanzi is not a headword either.
    expect(needsProposals('我打算明天去北京')).toBe(true);
  });

  it('reserves room for the proposed phrases inside the cap', () => {
    const search = entriesFor('看', '看到', '看见', '看病', '看法', '看来', '看待', '看好');
    const many = Array.from({ length: 60 }, (_, index) => ({ ...search[0], id: `filler-${index}` }));
    const candidates = entriesFor('随便', '看看');

    const merged = mergeRetrieved(many, candidates);
    expect(merged.length).toBeLessThanOrEqual(RETRIEVED_CAP);
    // The head of the search is kept, then the proposals — otherwise a broad
    // query eats the cap and the words the answer needs never arrive.
    expect(merged.slice(0, SEARCH_HEAD).map((entry) => entry.id)).toEqual(
      many.slice(0, SEARCH_HEAD).map((entry) => entry.id),
    );
    for (const entry of candidates) expect(merged.map((row) => row.id)).toContain(entry.id);
  });

  it('deduplicates across the two sources', () => {
    const shared = entriesFor('看看');
    expect(mergeRetrieved(shared, shared)).toHaveLength(shared.length);
  });
});

describe('when data/ has not been built', () => {
  const previous = process.env.TANGRAM_DATA_DIR;

  beforeAll(() => {
    process.env.TANGRAM_DATA_DIR = mkdtempSync(join(tmpdir(), 'tangram-ask-nodata-'));
    resetDictCache();
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.TANGRAM_DATA_DIR;
    else process.env.TANGRAM_DATA_DIR = previous;
    resetDictCache();
  });

  it('answers 503 with the command that fixes it, like the dictionary routes', async () => {
    const res = await POST(ask({ query: 'dasuan', profile: PROFILE }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'dict-data-missing', hint: 'run pnpm data' });
  });
});
