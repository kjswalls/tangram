// @vitest-environment node
/**
 * `/api/ask` against providers that misbehave (the Phases 4–5 review).
 *
 * The fake is well behaved by construction, so these mock the seam instead: an
 * answer that is schema-valid and grounds to nothing, and a provider that never
 * answers at all. Both were 200-with-an-empty-panel and an unbounded wait
 * before the review.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LLMProvider, ParsedAskResponse, ProposedPhrases } from '@/lib/ai/provider';
import { requireDictData } from '../dict/data-required';
import { entryFor } from './helpers';

/** The provider the route selects, swappable per test. */
let stub: LLMProvider | undefined;

vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  return { ...actual, selectProvider: () => stub ?? actual.selectProvider() };
});

const { POST } = await import('@/app/api/ask/route');
type AskRouteResponse = import('@/app/api/ask/route').AskRouteResponse;

beforeAll(requireDictData);

afterEach(() => {
  stub = undefined;
  delete process.env.TANGRAM_ASK_ANSWER_TIMEOUT_MS;
  delete process.env.TANGRAM_ASK_PROPOSE_TIMEOUT_MS;
});

const PROFILE = { estimatedBand: 2, knownSample: [] };

function provider(overrides: Partial<LLMProvider>): LLMProvider {
  return {
    name: 'fake',
    async proposePhrases(): Promise<ProposedPhrases> {
      return { candidates: [] };
    },
    async answer(): Promise<ParsedAskResponse> {
      return { interpretation: 'nothing', matches: [], sayIt: [], notes: [] };
    },
    ...overrides,
  } as LLMProvider;
}

async function post(body: unknown): Promise<{ status: number; body: AskRouteResponse }> {
  const res = await POST(
    new Request('http://localhost/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as AskRouteResponse };
}

describe('an answer that grounds to nothing', () => {
  it('falls back to the dictionary rather than rendering an empty panel', async () => {
    // The commonest thing a live model does wrong: write the Chinese into the
    // prose and cite an id it was never given.
    stub = provider({
      async answer() {
        return {
          interpretation: '我随便看看',
          matches: [{ entryId: 'bogus', senseIndex: 0, whyThisOne: '随便' }],
          sayIt: [{ tokens: [{ entryId: 'bogus' }], en: '看看', register: '口語' }],
          notes: ['看看'],
        };
      },
    });

    const { status, body } = await post({ query: '随便', profile: PROFILE });
    expect(status).toBe(200);
    expect(body.response.interpretation.length).toBeGreaterThan(0);
    expect(body.response.matches.length).toBeGreaterThan(0);
    // And it must not be remembered: the next ask should reach the provider.
    expect(body.cacheable).toBe(false);
  });

  it('says so even when the provider returns the empty-but-valid answer', async () => {
    stub = provider({
      async answer() {
        return { interpretation: '', matches: [], sayIt: [], notes: [] };
      },
    });
    const { body } = await post({ query: '打算', profile: PROFILE });
    expect(body.response.interpretation.length).toBeGreaterThan(0);
    expect(body.cacheable).toBe(false);
  });

  it('keeps a real answer cacheable', async () => {
    const dasuan = entryFor('打算');
    stub = provider({
      async answer(retrieved) {
        const cited = retrieved.find((entry) => entry.id === dasuan.id) ?? retrieved[0];
        return {
          interpretation: 'The everyday verb for planning to do something.',
          matches: [{ entryId: cited.id, senseIndex: 0, whyThisOne: 'the verb sense' }],
          sayIt: [],
          notes: [],
        };
      },
    });
    const { body } = await post({ query: '打算', profile: PROFILE });
    expect(body.cacheable).toBe(true);
    expect(body.response.matches).toHaveLength(1);
  });
});

describe('a provider that never answers', () => {
  it('gives up on `answer` with a 502 instead of hanging the request', async () => {
    process.env.TANGRAM_ASK_ANSWER_TIMEOUT_MS = '40';
    stub = provider({
      answer: () => new Promise<ParsedAskResponse>(() => {}),
    });

    const started = Date.now();
    const res = await POST(
      new Request('http://localhost/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '打算', profile: PROFILE }),
      }),
    );
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(5_000);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe('provider-failed');
    expect(body.hint).toMatch(/took longer/);
  });

  it('gives up on `proposePhrases` and answers from the dictionary search alone', async () => {
    process.env.TANGRAM_ASK_PROPOSE_TIMEOUT_MS = '40';
    stub = provider({
      proposePhrases: () => new Promise<ProposedPhrases>(() => {}),
      async answer(retrieved) {
        return {
          interpretation: 'answered without any proposals',
          matches: retrieved[0]
            ? [{ entryId: retrieved[0].id, senseIndex: 0, whyThisOne: 'first hit' }]
            : [],
          sayIt: [],
          notes: [],
        };
      },
    });

    const { status, body } = await post({ query: 'how do I say I am just browsing', profile: PROFILE });
    expect(status).toBe(200);
    expect(body.response.interpretation).toBe('answered without any proposals');
    expect(body.retrieved).toBeGreaterThan(0);
  });
});
