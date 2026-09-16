// @vitest-environment node
/**
 * `/api/examples` after `backend.md` B2's contract flip — the **server** half.
 *
 * **What this file used to be.** It exercised the whole i+1 pipeline through the
 * handler, because the handler held the dictionary: it resolved the target,
 * expanded the learner's known set into rows, asked the provider, grounded the
 * sentences and *filtered* them. After the flip the server does one of those
 * five. The other four are the client's and their assertions moved with them:
 *
 *  - the filter cases (a sentence citing an unknown word, a sentence carrying
 *    characters the model wrote itself, a sentence citing the other reading of a
 *    known headword) → `tests/unit/ai/examples.test.ts`, which already owns
 *    `keepSentence` and `groundExamples`, plus an end-to-end case in
 *    `tests/unit/ai/examples-card.test.tsx` proving the card back runs them;
 *  - the support-pool cases (frequency order, a headword is not a word, the band
 *    expansion, a card outranking the band) → `tests/unit/srs/support-pool.test.ts`,
 *    over `supportEntries` in `lib/srs/known-set.ts`, which is where the pool is
 *    assembled now;
 *  - "is a 404 for an id this dictionary does not have" → the client cannot send
 *    an id it does not have a row for, so the case becomes "the card names an
 *    entry this build dropped" in `examples-card.test.tsx`;
 *  - "answers 503 when `data/` has not been built" → **deleted**. This server has
 *    no dictionary, so it cannot have a missing one.
 *
 * What is left is what a server can still be wrong about: the handshake, the
 * edge validator, and a provider that throws, hangs or answers off-schema.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  LLMProvider,
  ParsedExampleSentences,
  ParsedGradeRecall,
} from '@tangram/ai/provider';
import { EXAMPLES_PROMPT_VERSION } from '@tangram/ai/cache-key';
import {
  MAX_EXAMPLE_SENTENCES,
  SUPPORT_CAP,
  type AskInfoResponse,
  type ExamplesResponse,
  type LearnerProfile,
  type RetrievedEntry,
} from '@tangram/ai/schemas';

/** What `selectProvider` hands the route, when a case wants to choose. */
const stubbed = vi.hoisted(() => ({ provider: undefined as LLMProvider | undefined }));

vi.mock('@tangram/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tangram/ai/provider')>();
  const { FakeProvider } = await import('@tangram/ai/fake');
  return {
    ...actual,
    selectProvider: () => stubbed.provider ?? new FakeProvider(),
  };
});

const { GET, POST } = await import('@server/routes/examples.ts');

afterEach(() => {
  stubbed.provider = undefined;
  delete process.env.TANGRAM_EXAMPLES_TIMEOUT_MS;
});

const PROFILE: LearnerProfile = { estimatedBand: 2, knownSample: ['我', '是'] };

const KAISHI: RetrievedEntry = {
  id: '開始|开始[kai1 shi3]',
  simp: '开始',
  trad: '開始',
  pinyinMarked: 'kāishǐ',
  hskBand: 2,
  glosses: ['to begin', 'to start'],
};

const WO: RetrievedEntry = {
  id: '我|我[wo3]',
  simp: '我',
  trad: '我',
  pinyinMarked: 'wǒ',
  hskBand: 1,
  glosses: ['I', 'me'],
};

function request(body: unknown): Request {
  return new Request('http://localhost/api/examples', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown): Promise<{ status: number; body: ExamplesResponse }> {
  const res = await POST(request(body));
  return { status: res.status, body: (await res.json()) as ExamplesResponse };
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

describe('GET /api/examples', () => {
  it('reports the provider and the prompt version the card back keys its cache on', async () => {
    const info = (await GET(new Request('http://localhost/api/examples')).json()) as AskInfoResponse;
    expect(info).toEqual({ provider: 'fake', promptVersion: EXAMPLES_PROMPT_VERSION });
  });
});

describe('the request', () => {
  it('rejects a body with no entry', async () => {
    expect((await POST(request({ profile: PROFILE }))).status).toBe(400);
  });

  it('rejects a nonsense senseIndex rather than guessing one', async () => {
    expect((await POST(request({ entry: KAISHI, senseIndex: -1, profile: PROFILE }))).status).toBe(400);
  });

  it('rejects an entry that is not a dictionary row', async () => {
    // After the flip the caller supplies the row, so "is this a row" is a thing
    // the edge has to decide. An id alone — which is what this route used to
    // take — is now a 400 rather than a lookup.
    expect((await POST(request({ entry: KAISHI.id, profile: PROFILE }))).status).toBe(400);
    expect(
      (await POST(request({ entry: { id: KAISHI.id }, profile: PROFILE }))).status,
    ).toBe(400);
  });

  it('refuses a support pool over the cap', async () => {
    const many = Array.from({ length: SUPPORT_CAP + 1 }, (_unused, index) => ({
      ...WO,
      id: `x|x[x${index}]`,
    }));
    const res = await POST(request({ entry: KAISHI, profile: PROFILE, support: many }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { hint: string }).hint).toContain(String(SUPPORT_CAP));
  });

  it('takes a bare request with no support at all', async () => {
    // "Declares nothing when the body declares nothing" — the learner three days
    // in, with no known words. It is legal and the answer is the word by itself.
    const { status, body } = await post({ entry: KAISHI, profile: PROFILE });
    expect(status).toBe(200);
    expect(body.sentences).toHaveLength(1);
    expect(body.sentences[0]?.tokens).toEqual([{ entryId: KAISHI.id }]);
  });
});

describe('what comes back', () => {
  it('is ungrounded and unfiltered, and the client is what fixes that', async () => {
    // The flip in one assertion. The provider cites an entry the caller never
    // offered; the server passes it through, because it has no dictionary to
    // judge it with. `examples-card.test.tsx` is where it is dropped.
    stubbed.provider = stub(() => ({
      sentences: [
        { tokens: [{ entryId: 'stranger|stranger[x]' }, { entryId: KAISHI.id }], en: 'Unknown.' },
      ],
    }));
    const { status, body } = await post({ entry: KAISHI, profile: PROFILE, support: [WO] });
    expect(status).toBe(200);
    expect(body.sentences).toHaveLength(1);
    expect(body.sentences[0]?.tokens[0]).toEqual({ entryId: 'stranger|stranger[x]' });
    // Nothing that used to travel back does any more.
    expect(body).not.toHaveProperty('entries');
    expect(body).not.toHaveProperty('dictVersion');
    expect(body).not.toHaveProperty('cacheable');
    expect(body).not.toHaveProperty('support');
  });

  it('caps how many sentences one call may return', async () => {
    stubbed.provider = stub(() => ({
      sentences: Array.from({ length: MAX_EXAMPLE_SENTENCES + 3 }, (_unused, index) => ({
        tokens: [{ entryId: KAISHI.id }],
        en: `sentence ${index}`,
      })),
    }));
    const { body } = await post({ entry: KAISHI, profile: PROFILE });
    expect(body.sentences).toHaveLength(MAX_EXAMPLE_SENTENCES);
  });

  it('hands the provider the target and the support pool as the caller sent them', async () => {
    let seen: { entry: RetrievedEntry; support: readonly RetrievedEntry[] } | undefined;
    stubbed.provider = {
      name: 'fake',
      proposePhrases: async () => ({ candidates: [] }),
      answer: async () => ({ interpretation: '', matches: [], sayIt: [], notes: [] }),
      exampleSentences: async (entry, _profile, _senseIndex, support) => {
        seen = { entry, support: support ?? [] };
        return { sentences: [] };
      },
      gradeRecall: async (): Promise<ParsedGradeRecall> => ({ suggested: 3, why: '' }),
    };
    await post({ entry: KAISHI, profile: PROFILE, support: [WO] });
    expect(seen?.entry).toEqual(KAISHI);
    expect(seen?.support).toEqual([WO]);
    // `hskBand` survives the wire, because `entryLine` renders it. A prompt that
    // lost it would be a model-behaviour change smuggled in as transport.
    expect(seen?.entry.hskBand).toBe(2);
  });
});

describe('a provider that misbehaves', () => {
  it('is a 502 when the provider throws', async () => {
    stubbed.provider = stub(() => {
      throw new Error('upstream is on fire');
    });
    const res = await POST(request({ entry: KAISHI, profile: PROFILE }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe('provider-failed');
    expect(body.hint).toContain('upstream is on fire');
  });

  it('is a 502 when the provider answers off-schema', async () => {
    stubbed.provider = stub(() => ({ sentences: [{ tokens: [], en: 42 }] }) as never);
    const res = await POST(request({ entry: KAISHI, profile: PROFILE }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('provider-invalid');
  });

  it('is a 502 when the provider never comes back, rather than a card that hangs', async () => {
    process.env.TANGRAM_EXAMPLES_TIMEOUT_MS = '5';
    stubbed.provider = stub(() => new Promise<ParsedExampleSentences>(() => {}));
    const res = await POST(request({ entry: KAISHI, profile: PROFILE }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { hint: string }).hint).toContain('longer than');
  });
});
