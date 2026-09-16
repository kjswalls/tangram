// @vitest-environment node
/**
 * `POST /api/recall` after `backend.md` B2's contract flip.
 *
 * **The route that flips least.** It always needed one thing from the dictionary
 * — the entry's glosses — and the only change is that the caller sends them
 * instead of sending an id for the server to look up. So every assertion below
 * is the one that was here before, with `{ entryId }` replaced by `{ entry }`,
 * and the two that could not survive are named:
 *
 *  - "is a 404 for an entry this dictionary build does not have" → **deleted**.
 *    There is no dictionary here to miss an id in, and the caller reads the row
 *    off the card's own `EntrySnapshot`, which is why free recall keeps working
 *    on a device that never downloaded the dictionary
 *    (`components/review/recall-input.tsx`).
 *  - `parseRecallBody`'s own unit case → the body parser is `src/wire.ts`'s zod
 *    schema now, so the same behaviour is asserted through `POST` below.
 *
 * What is pinned is everything the client is allowed to assume: the grade is one
 * of four numbers, the reason is plain English with no Chinese in it, and every
 * way the provider can misbehave — throwing, hanging, answering with a 7 — comes
 * back as a 502 rather than as something the card front would try to render.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { gradeRecallWith, POST } from '@server/routes/recall.ts';
import { RECALL_ANSWER_MAX_CHARS, RECALL_GRADE_VALUES } from '@tangram/ai/recall';
import { ProviderError, RECALL_GRADES, type LLMProvider } from '@tangram/ai/provider';
import type { RecallResponse, RetrievedEntry } from '@tangram/ai/schemas';

const CJK = /[㐀-䶿一-鿿]/;

afterEach(() => {
  delete process.env.TANGRAM_RECALL_TIMEOUT_MS;
});

/** The row a review card carries in its own snapshot. */
const DASUAN: RetrievedEntry = {
  id: '打算|打算[da3 suan4]',
  simp: '打算',
  trad: '打算',
  pinyinMarked: 'dǎsuàn',
  hskBand: 3,
  glosses: ['to plan', 'to intend', 'to calculate', 'calculation', 'plan', 'intention'],
};

const KAN: RetrievedEntry = {
  id: '看|看[kan4]',
  simp: '看',
  trad: '看',
  pinyinMarked: 'kàn',
  hskBand: 1,
  glosses: ['to see', 'to look at', 'to read', 'to watch'],
};

function recall(body: unknown): Request {
  return new Request('http://localhost/api/recall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown): Promise<{ status: number; body: RecallResponse }> {
  const res = await POST(recall(body));
  return { status: res.status, body: (await res.json()) as RecallResponse };
}

/**
 * A provider that does one thing. The three methods this route never calls
 * throw, so a route that reached for one would fail loudly rather than quietly
 * pass the test.
 */
function providerThat(grade: (entry: RetrievedEntry, answer: string) => Promise<unknown>): LLMProvider {
  const unused = () => {
    throw new Error('the recall route called a method it has no business calling');
  };
  return {
    name: 'fake',
    proposePhrases: unused as never,
    answer: unused as never,
    exampleSentences: unused as never,
    gradeRecall: grade as never,
  };
}

describe('the body', () => {
  it('names what is missing rather than guessing', async () => {
    for (const [payload, hint] of [
      [null, 'send JSON'],
      [{ answer: 'to plan' }, 'entry'],
      [{ entry: DASUAN }, 'answer'],
      [{ entry: DASUAN, answer: '   ' }, 'answer'],
      [{ entry: DASUAN, answer: 'a'.repeat(RECALL_ANSWER_MAX_CHARS + 1) }, 'at most'],
      // An id where a row belongs: the shape the route took before the flip.
      [{ entry: DASUAN.id, answer: 'to plan' }, 'entry'],
    ] as const) {
      const res = await POST(recall(payload));
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect(((await res.json()) as { hint: string }).hint).toContain(hint);
    }
  });

  it('drops a sense index it cannot use instead of refusing the answer', async () => {
    // Unchanged from before the flip, and the asymmetry with `/api/examples` —
    // which rejects the same value — is deliberate: `src/wire.ts` says why. A
    // free-recall answer with a bad sense index is still an answer worth
    // grading, so it is judged against every gloss instead.
    const kept = await post({ entry: DASUAN, answer: 'to plan', senseIndex: 2 });
    expect(kept.status).toBe(200);
    for (const senseIndex of [-1, 1.5, '0', null]) {
      const res = await post({ entry: DASUAN, answer: 'to plan', senseIndex });
      expect(res.status, String(senseIndex)).toBe(200);
      // Judged against the whole entry, which a sense index of 2
      // ("to calculate") is not: the two answers differ.
      expect(res.body.suggested, String(senseIndex)).toBeGreaterThan(kept.body.suggested);
    }
  });
});

describe('the offline grade, end to end', () => {
  it('reads a good answer high and a wrong one as a lapse', async () => {
    const good = await post({ entry: DASUAN, answer: 'to plan or intend to do something' });
    expect(good.status).toBe(200);
    expect(good.body.provider).toBe('fake');
    expect(good.body.suggested).toBe(4);

    const wrong = await post({ entry: DASUAN, answer: 'a kind of river fish' });
    expect(wrong.status).toBe(200);
    expect(wrong.body.suggested).toBe(1);

    // Both reasons are prose a learner can read, and neither is Chinese.
    for (const body of [good.body, wrong.body]) {
      expect(body.why.length).toBeGreaterThan(0);
      expect(body.why).not.toMatch(CJK);
    }
  });

  it('judges the sense the card is about when it names one', async () => {
    const senseIndex = DASUAN.glosses.findIndex((gloss) => gloss.includes('calculate'));
    expect(senseIndex).toBeGreaterThan(0);

    const narrow = await post({ entry: DASUAN, senseIndex, answer: 'to plan' });
    const wide = await post({ entry: DASUAN, answer: 'to plan' });
    expect(narrow.body.suggested).toBeLessThan(wide.body.suggested);
  });

  it('answers with one of the four grades and nothing else', async () => {
    const { body } = await post({ entry: KAN, answer: 'to look at, to watch, to read' });
    expect(RECALL_GRADE_VALUES).toContain(body.suggested);
  });
});

describe('the three vocabularies that must agree', () => {
  it('says 1 to 4 in the provider seam and in the client module alike', () => {
    expect([...RECALL_GRADE_VALUES]).toEqual([...RECALL_GRADES]);
  });
});

describe('a provider that misbehaves', () => {
  it('scrubs hanzi and pinyin out of the reason, using the ask pipeline’s own scrubber', async () => {
    // **This one stays on the server**, and `backend.md` B2 says why: scrubbing
    // `why` is not a rendering concern, it is what stops an unchecked reading
    // reaching the card front. `asRecallSuggestion` scrubs it again on the
    // client; both are meant.
    const res = await gradeRecallWith(
      providerThat(async () => ({
        suggested: 3,
        why: 'You wrote 打算 (dǎsuàn) — the 计划 sense, roughly right.',
      })),
      DASUAN,
      'to plan',
    );
    const body = (await res.json()) as RecallResponse;

    expect(res.status).toBe(200);
    expect(body.why).not.toMatch(CJK);
    expect(body.why).not.toMatch(/dǎsuàn/);
    expect(body.why).toContain('roughly right');
  });

  it('flattens a reason that runs on into one capped line', async () => {
    const res = await gradeRecallWith(
      providerThat(async () => ({ suggested: 2, why: `line one\nline two ${'x'.repeat(600)}` })),
      DASUAN,
      'to plan',
    );
    const body = (await res.json()) as RecallResponse;
    expect(body.why).not.toContain('\n');
    expect(body.why.length).toBeLessThanOrEqual(320);
  });

  it('is a 502 when the provider throws', async () => {
    const res = await gradeRecallWith(
      providerThat(async () => {
        throw new ProviderError('fake', 'the model refused');
      }),
      DASUAN,
      'to plan',
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe('provider-failed');
    expect(body.hint).toContain('refused');
  });

  it('is a 502 for a grade outside 1–4, rather than an unhighlightable button', async () => {
    for (const suggested of [0, 5, 2.5, '3', null]) {
      const res = await gradeRecallWith(
        providerThat(async () => ({ suggested, why: 'sure' })),
        DASUAN,
        'to plan',
      );
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBe('provider-invalid');
    }
  });

  it('is a 502 when the provider hangs past the deadline', async () => {
    process.env.TANGRAM_RECALL_TIMEOUT_MS = '20';
    const res = await gradeRecallWith(
      providerThat(() => new Promise(() => {})),
      DASUAN,
      'to plan',
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe('provider-failed');
    expect(body.hint).toContain('longer than 20 ms');
  });
});
