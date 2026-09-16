// @vitest-environment node
/**
 * The ask endpoints, after `backend.md` B2's contract flip — the **server** half
 * and nothing else.
 *
 * **What this file used to be, and where the rest of it went.** Before B2 it
 * exercised the whole of §3.4 through one handler: the merged dictionary
 * search, the proposed phrases, the segmentation, the union, the answer, the
 * grounding, and the entries that came back for rendering. After the flip the
 * server holds no dictionary, so all of that is `lib/ai/ask-client.ts`'s and
 * every one of those assertions moved to `tests/unit/ai/ask-client.test.ts`,
 * with the pure retrieval cases in `tests/unit/ai/retrieve.test.ts`. What is
 * left here is what a server can still be wrong about: the handshake, the edge
 * validator, and the model call.
 *
 * **One case went nowhere, and that is the phase's headline.** "When `data/` has
 * not been built, answer 503 `dict-data-missing`" is deleted rather than moved:
 * this server has no dictionary, so it cannot have a missing one, and
 * `ContractErrorCode` in the frozen contract does not list that code. The
 * client's own missing-dictionary banner is `data.md`'s (`DictStatus`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LLMProvider, ParsedAskResponse, ProposedPhrases } from '@tangram/ai/provider';
import { ASK_PROMPT_VERSION } from '@tangram/ai/cache-key';
import {
  MAX_QUERY_CHARS,
  RETRIEVED_CAP,
  type AskAnswerResponse,
  type AskInfoResponse,
  type AskProposeResponse,
  type RetrievedEntry,
} from '@tangram/ai/schemas';
import { MAX_BODY_BYTES } from '@tangram/ai/schemas';

/** The provider the routes select, swappable per case. */
let stub: LLMProvider | undefined;

vi.mock('@tangram/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tangram/ai/provider')>();
  return { ...actual, selectProvider: () => stub ?? actual.selectProvider() };
});

const { ANSWER, GET, PROPOSE } = await import('@server/routes/ask.ts');

afterEach(() => {
  stub = undefined;
  delete process.env.TANGRAM_ASK_ANSWER_TIMEOUT_MS;
  delete process.env.TANGRAM_ASK_PROPOSE_TIMEOUT_MS;
});

const PROFILE = { estimatedBand: 2, knownSample: ['我', '是'] };

/**
 * A dictionary row as the client now sends it. Hand-built rather than read from
 * `data/`: after the flip the server's view of an entry is whatever the caller
 * claims, and a test that fetched a real one would be testing the dictionary.
 */
const DASUAN: RetrievedEntry = {
  id: '打算|打算[da3 suan4]',
  simp: '打算',
  trad: '打算',
  pinyinMarked: 'dǎsuàn',
  hskBand: 3,
  glosses: ['to plan', 'to intend'],
};

function post(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

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

async function hint(res: Response): Promise<string> {
  return ((await res.json()) as { hint?: string }).hint ?? '';
}

// ---------------------------------------------------------------------------

describe('GET /api/ask', () => {
  it('reports the provider and the prompt version the client needs for the cache key', async () => {
    const res = GET(new Request('http://localhost/api/ask'));
    expect(res.status).toBe(200);
    const info = (await res.json()) as AskInfoResponse;
    // No key in this container, so the fake answers — and says so.
    expect(info).toEqual({ provider: 'fake', promptVersion: ASK_PROMPT_VERSION });
  });
});

describe('POST /api/ask/propose', () => {
  it('returns the provider’s candidates under the same handshake', async () => {
    stub = provider({ async proposePhrases() { return { candidates: ['随便', '看看'] }; } });
    const res = await PROPOSE(post('/api/ask/propose', { query: 'just browsing' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AskProposeResponse;
    expect(body).toEqual({
      provider: 'fake',
      promptVersion: ASK_PROMPT_VERSION,
      candidates: ['随便', '看看'],
    });
  });

  it('rejects a body with no query', async () => {
    expect((await PROPOSE(post('/api/ask/propose', {}))).status).toBe(400);
    expect((await PROPOSE(post('/api/ask/propose', { query: '   ' }))).status).toBe(400);
  });

  it('is a 502 when the provider hangs, rather than a request that never ends', async () => {
    // Moved from `route-provider.test.ts`, where the same deadline was asserted
    // through the merged route. The *consequence* changed and is asserted on the
    // other side: `ask-client.test.ts` proves the client carries on without
    // candidates, which is what the merged route did inside one request.
    process.env.TANGRAM_ASK_PROPOSE_TIMEOUT_MS = '20';
    stub = provider({ proposePhrases: () => new Promise<ProposedPhrases>(() => {}) });
    const res = await PROPOSE(post('/api/ask/propose', { query: 'anything' }));
    expect(res.status).toBe(502);
    expect(await hint(res)).toMatch(/took longer/);
  });
});

describe('POST /api/ask/answer', () => {
  it('answers over the entries the caller supplied, and grounds nothing', async () => {
    // The whole of the flip in one assertion: the body comes back
    // schema-validated and otherwise untouched, including a citation the
    // *client* will have to drop. A server that grounded would have removed it.
    stub = provider({
      async answer(retrieved) {
        expect(retrieved.map((entry) => entry.id)).toEqual([DASUAN.id]);
        return {
          interpretation: 'The everyday verb 打算.',
          matches: [{ entryId: 'never-retrieved', senseIndex: 99, whyThisOne: 'invented' }],
          sayIt: [],
          notes: [],
        };
      },
    });
    const res = await ANSWER(
      post('/api/ask/answer', { query: '打算', profile: PROFILE, retrieved: [DASUAN] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AskAnswerResponse;
    expect(body.provider).toBe('fake');
    expect(body.promptVersion).toBe(ASK_PROMPT_VERSION);
    expect(body.response.matches).toEqual([
      { entryId: 'never-retrieved', senseIndex: 99, whyThisOne: 'invented' },
    ]);
    expect(body.response.interpretation).toContain('打算');
    // Nothing that used to travel back does any more: the client has the rows.
    expect(body).not.toHaveProperty('entries');
    expect(body).not.toHaveProperty('dictVersion');
    expect(body).not.toHaveProperty('cacheable');
  });

  it('rejects a body with no query', async () => {
    expect((await ANSWER(post('/api/ask/answer', { profile: PROFILE, retrieved: [] }))).status).toBe(400);
    expect(
      (await ANSWER(post('/api/ask/answer', { query: '  ', profile: PROFILE, retrieved: [] }))).status,
    ).toBe(400);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await ANSWER(
      new Request('http://localhost/api/ask/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('survives a missing profile rather than failing the ask', async () => {
    // Unchanged from before the flip: the profile is a hint about the learner,
    // and a client that omits it gets HSK 1 and no known sample.
    stub = provider({
      async answer(_retrieved, profile) {
        expect(profile).toEqual({ estimatedBand: 1, knownSample: [] });
        return { interpretation: 'fine', matches: [], sayIt: [], notes: [] };
      },
    });
    const res = await ANSWER(post('/api/ask/answer', { query: '打算', retrieved: [DASUAN] }));
    expect(res.status).toBe(200);
  });

  it('refuses a query over the cap and a retrieved set over the cap', async () => {
    const long = await ANSWER(
      post('/api/ask/answer', {
        query: 'x'.repeat(MAX_QUERY_CHARS + 1),
        profile: PROFILE,
        retrieved: [],
      }),
    );
    expect(long.status).toBe(400);
    expect(await hint(long)).toContain('at most');

    const many = Array.from({ length: RETRIEVED_CAP + 1 }, (_unused, index) => ({
      ...DASUAN,
      id: `x|x[x${index}]`,
    }));
    const over = await ANSWER(
      post('/api/ask/answer', { query: '打算', profile: PROFILE, retrieved: many }),
    );
    expect(over.status).toBe(400);
    expect(await hint(over)).toContain(String(RETRIEVED_CAP));
  });

  it('refuses a body over the byte cap before it reaches a provider', async () => {
    // Cost control, which is what validation is for after the flip. The header
    // is checked first so an oversized body is refused without being read.
    let called = false;
    stub = provider({
      async answer() {
        called = true;
        return { interpretation: '', matches: [], sayIt: [], notes: [] };
      },
    });
    const res = await ANSWER(
      new Request('http://localhost/api/ask/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1) },
        body: JSON.stringify({ query: '打算', profile: PROFILE, retrieved: [] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await hint(res)).toContain('bytes');
    expect(called).toBe(false);
  });

  it('refuses a body whose declared length lies low', async () => {
    const huge = 'x'.repeat(MAX_BODY_BYTES + 1_000);
    const res = await ANSWER(
      new Request('http://localhost/api/ask/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '打算', profile: PROFILE, retrieved: [], padding: huge }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await hint(res)).toContain('bytes');
  });

  it('never reads the model from the request', async () => {
    // `schemas.ts` rule 2: "a client that could name the model could name the
    // most expensive one." There is no `model` field on any request type, and
    // the response reports what the *server* chose.
    stub = provider({});
    const res = await ANSWER(
      post('/api/ask/answer', {
        query: '打算',
        profile: PROFILE,
        retrieved: [DASUAN],
        model: 'claude-something-enormous',
      }),
    );
    const body = (await res.json()) as AskAnswerResponse;
    // The fake has no model at all, so the field is absent — and it is
    // certainly not the one the caller named.
    expect(body.model).toBeUndefined();
  });

  it('is a 502 when the provider throws', async () => {
    stub = provider({
      answer: async () => {
        throw new Error('upstream is on fire');
      },
    });
    const res = await ANSWER(
      post('/api/ask/answer', { query: '打算', profile: PROFILE, retrieved: [DASUAN] }),
    );
    expect(res.status).toBe(502);
    expect(await hint(res)).toContain('upstream is on fire');
  });

  it('is a 502 when the provider answers off-schema', async () => {
    stub = provider({ answer: async () => ({ interpretation: 42 }) as never });
    const res = await ANSWER(
      post('/api/ask/answer', { query: '打算', profile: PROFILE, retrieved: [DASUAN] }),
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('provider-invalid');
  });

  it('gives up on a provider that never answers, instead of hanging the request', async () => {
    // Moved from `route-provider.test.ts` unchanged in intent.
    process.env.TANGRAM_ASK_ANSWER_TIMEOUT_MS = '40';
    stub = provider({ answer: () => new Promise<ParsedAskResponse>(() => {}) });
    const started = Date.now();
    const res = await ANSWER(
      post('/api/ask/answer', { query: '打算', profile: PROFILE, retrieved: [DASUAN] }),
    );
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await hint(res)).toMatch(/took longer/);
  });
});

describe('the server holds no dictionary', () => {
  it('answers with data/ absent, because it never looks for it', async () => {
    // The replacement for "when data/ has not been built". `TANGRAM_DATA_DIR`
    // is pointed somewhere empty and both endpoints answer normally, which is
    // the whole payoff of the flip: a deployment with no artifact is correct.
    const previous = process.env.TANGRAM_DATA_DIR;
    process.env.TANGRAM_DATA_DIR = '/nonexistent/tangram-b2';
    try {
      const propose = await PROPOSE(post('/api/ask/propose', { query: 'anything' }));
      expect(propose.status).toBe(200);
      const answer = await ANSWER(
        post('/api/ask/answer', { query: '打算', profile: PROFILE, retrieved: [DASUAN] }),
      );
      expect(answer.status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.TANGRAM_DATA_DIR;
      else process.env.TANGRAM_DATA_DIR = previous;
    }
  });
});
