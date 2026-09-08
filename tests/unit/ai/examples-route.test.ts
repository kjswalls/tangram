// @vitest-environment node
/**
 * `/api/examples` (PLAN.md §4, Phase 6 item 1), called the way the Phase 0
 * route tests call a handler: with a `Request`.
 *
 * The point of most of these cases is the one thing the fake provider cannot
 * demonstrate — that a **misbehaving** provider gets nothing onto a card back.
 * "The prompt asks, the filter enforces" is only a claim worth making if
 * something has actually broken the rules and been stopped, so `selectProvider`
 * is mocked and a stub is handed answers that cite a word the learner has never
 * met, write their own characters, throw, hang, or answer off-schema.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  LLMProvider,
  ParsedExampleSentences,
  ParsedGradeRecall,
} from '@/lib/ai/provider';
import { EXAMPLES_PROMPT_VERSION } from '@/lib/ai/cache-key';
import { resetDictCache } from '@/lib/dict/load';
import type { Entry, LearnerProfile } from '@/lib/types';
import { requireDictData } from '../dict/data-required';
import { entryFor } from './helpers';

/** What `selectProvider` hands the route, when a case wants to choose. */
const stubbed = vi.hoisted(() => ({ provider: undefined as LLMProvider | undefined }));

vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  const { FakeProvider } = await import('@/lib/ai/fake');
  return {
    ...actual,
    selectProvider: () => stubbed.provider ?? new FakeProvider(),
  };
});

const { GET, POST, SUPPORT_CAP, supportEntries } = await import('@/app/api/examples/route');
type ExamplesRouteResponse = import('@/app/api/examples/route').ExamplesRouteResponse;
type ExamplesRouteInfo = import('@/app/api/examples/route').ExamplesRouteInfo;

beforeAll(requireDictData);
afterEach(() => {
  stubbed.provider = undefined;
});

/** HSK 1–2 words, the way a demo learner's known set arrives. */
const KNOWN = ['我', '是', '的', '很', '好', '你', '天', '看', '书', '学习'];
const PROFILE: LearnerProfile = { estimatedBand: 2, knownSample: KNOWN };

function request(body: unknown): Request {
  return new Request('http://localhost/api/examples', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown): Promise<{ status: number; body: ExamplesRouteResponse }> {
  const res = await POST(request(body));
  return { status: res.status, body: (await res.json()) as ExamplesRouteResponse };
}

/** A provider that answers whatever the case wants, and nothing else. */
function stub(answer: () => ParsedExampleSentences | Promise<ParsedExampleSentences>): LLMProvider {
  return {
    name: 'fake',
    proposePhrases: async () => ({ candidates: [] }),
    answer: async () => ({ interpretation: '', matches: [], sayIt: [], notes: [] }),
    exampleSentences: async () => answer(),
    gradeRecall: async (): Promise<ParsedGradeRecall> => ({ suggested: 3, why: '' }),
  };
}

const target = (): Entry => entryFor('开始');

describe('GET /api/examples', () => {
  it('reports the provider and the prompt version the card back keys its cache on', async () => {
    const info = (await GET().json()) as ExamplesRouteInfo;
    expect(info).toEqual({ provider: 'fake', promptVersion: EXAMPLES_PROMPT_VERSION });
  });
});

describe('the request', () => {
  it('rejects a body with no entry', async () => {
    const res = await POST(request({ profile: PROFILE }));
    expect(res.status).toBe(400);
  });

  it('rejects a nonsense senseIndex rather than guessing one', async () => {
    const res = await POST(request({ entryId: target().id, senseIndex: -1, profile: PROFILE }));
    expect(res.status).toBe(400);
  });

  it('is a 404 for an id this dictionary does not have', async () => {
    const res = await POST(request({ entryId: 'bogus|bogus[bo1 gus4]', profile: PROFILE }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('entry-not-found');
  });
});

describe('the offline provider', () => {
  it('answers with sentences that cite only the target and words the learner knows', async () => {
    const entry = target();
    const { status, body } = await post({ entryId: entry.id, profile: PROFILE, known: KNOWN });

    expect(status).toBe(200);
    expect(body.provider).toBe('fake');
    expect(body.sentences.length).toBeGreaterThan(0);
    expect(body.sentences.length).toBeLessThanOrEqual(2);

    const allowed = new Set(supportEntries(KNOWN, entry.id).map((row) => row.id));
    for (const sentence of body.sentences) {
      expect(sentence.tokens.length).toBeGreaterThan(0);
      for (const token of sentence.tokens) {
        expect(token.entryId).toBeDefined();
        expect(token.entryId === entry.id || allowed.has(token.entryId as string)).toBe(true);
      }
      // Every sentence is about the card's own word.
      expect(sentence.tokens.some((token) => token.entryId === entry.id)).toBe(true);
    }

    // Every entry needed to draw the sentence travels with it: the card back
    // renders hanzi and pinyin from these rows and from nothing else.
    const returned = new Set(body.entries.map((row) => row.id));
    for (const sentence of body.sentences) {
      for (const token of sentence.tokens) expect(returned.has(token.entryId as string)).toBe(true);
    }
    expect(body.dictVersion).toMatch(/\d/);
    expect(body.cacheable).toBe(true);
  });

  it('falls back to the profile’s looser sample when no known set is sent', async () => {
    const { status, body } = await post({ entryId: target().id, profile: PROFILE });
    expect(status).toBe(200);
    expect(body.support).toBeGreaterThan(0);
  });

  it('still answers a learner who knows nothing yet, with the word by itself', async () => {
    const entry = target();
    const { body } = await post({
      entryId: entry.id,
      profile: { estimatedBand: 1, knownSample: [] },
      known: [],
    });
    expect(body.support).toBe(0);
    expect(body.sentences).toHaveLength(1);
    expect(body.sentences[0].tokens).toEqual([{ entryId: entry.id }]);
  });
});

describe('a provider that breaks the rules', () => {
  it('drops a sentence citing a word the learner does not know', async () => {
    const entry = target();
    const stranger = entryFor('图书馆');
    stubbed.provider = stub(() => ({
      sentences: [
        { tokens: [{ entryId: stranger.id }, { entryId: entry.id }], en: 'At the library.' },
      ],
    }));

    const { status, body } = await post({ entryId: entry.id, profile: PROFILE, known: KNOWN });
    expect(status).toBe(200);
    // Nothing reached the client: the filter runs here, not in the browser.
    expect(body.sentences).toEqual([]);
    expect(body.entries).toEqual([]);
    // …and an empty answer is never written into the cache, because the known
    // set it reflects is the one thing about this learner that will change.
    expect(body.cacheable).toBe(false);
  });

  it('drops a sentence carrying characters it wrote itself', async () => {
    const entry = target();
    const wo = entryFor('我');
    stubbed.provider = stub(() => ({
      sentences: [
        { tokens: [{ entryId: wo.id }, { text: '绝绝子' }, { entryId: entry.id }], en: 'Made up.' },
        { tokens: [{ entryId: wo.id }, { entryId: entry.id }], en: 'A real one.' },
      ],
    }));

    const { body } = await post({ entryId: entry.id, profile: PROFILE, known: KNOWN });
    expect(body.sentences).toHaveLength(1);
    expect(body.sentences[0].tokens.every((token) => token.entryId !== undefined)).toBe(true);
  });

  it('is a 502 when the provider throws', async () => {
    stubbed.provider = stub(() => {
      throw new Error('upstream is on fire');
    });
    const res = await POST(request({ entryId: target().id, profile: PROFILE }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe('provider-failed');
    expect(body.hint).toContain('upstream is on fire');
  });

  it('is a 502 when the provider answers off-schema', async () => {
    stubbed.provider = stub(() => ({ sentences: [{ tokens: [], en: 42 }] }) as never);
    const res = await POST(request({ entryId: target().id, profile: PROFILE }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('provider-invalid');
  });

  it('is a 502 when the provider never comes back, rather than a card that hangs', async () => {
    const previous = process.env.TANGRAM_EXAMPLES_TIMEOUT_MS;
    process.env.TANGRAM_EXAMPLES_TIMEOUT_MS = '5';
    stubbed.provider = stub(() => new Promise<ParsedExampleSentences>(() => {}));
    try {
      const res = await POST(request({ entryId: target().id, profile: PROFILE }));
      expect(res.status).toBe(502);
      expect((await res.json()).hint).toContain('longer than');
    } finally {
      if (previous === undefined) delete process.env.TANGRAM_EXAMPLES_TIMEOUT_MS;
      else process.env.TANGRAM_EXAMPLES_TIMEOUT_MS = previous;
    }
  });
});

describe('the support pool', () => {
  it('is frequency-ordered, excludes the target, and is bounded', () => {
    const entry = entryFor('我');
    const pool = supportEntries(['图书馆', '我', '是'], entry.id);
    expect(pool.some((row) => row.id === entry.id)).toBe(false);
    const ranks = pool.map((row) => row.freqRank ?? Number.MAX_SAFE_INTEGER);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(SUPPORT_CAP).toBeGreaterThan(0);
  });
});

describe('when data/ has not been built', () => {
  const previous = process.env.TANGRAM_DATA_DIR;

  beforeAll(() => {
    process.env.TANGRAM_DATA_DIR = mkdtempSync(join(tmpdir(), 'tangram-examples-nodata-'));
    resetDictCache();
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.TANGRAM_DATA_DIR;
    else process.env.TANGRAM_DATA_DIR = previous;
    resetDictCache();
  });

  it('answers 503 with the command that fixes it, like the dictionary routes', async () => {
    const res = await POST(request({ entryId: '开始|开始[kai1 shi3]', profile: PROFILE }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'dict-data-missing', hint: 'run pnpm data' });
  });
});
