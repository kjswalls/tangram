// @vitest-environment node
/**
 * `POST /api/recall` (PLAN.md §4, Phase 6 item 2), called the way the Phase 0
 * route tests call a handler: with a `Request`, against the real dictionary.
 *
 * What is pinned here is everything the client is allowed to assume: the grade
 * is one of four numbers, the reason is plain English with no Chinese in it,
 * and every way the provider can misbehave — throwing, hanging, answering with
 * a 7 — comes back as a 502 rather than as something the card front would try
 * to render.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { gradeRecallWith, parseRecallBody, POST, type RecallRouteResponse } from '@/app/api/recall/route';
import { RECALL_ANSWER_MAX_CHARS, RECALL_GRADE_VALUES } from '@/lib/ai/recall';
import { ProviderError, RECALL_GRADES, type LLMProvider } from '@/lib/ai/provider';
import type { Entry } from '@/lib/types';
import { requireDictData } from '../dict/data-required';
import { entryFor } from './helpers';

beforeAll(requireDictData);

const CJK = /[㐀-䶿一-鿿]/;

function recall(body: unknown): Request {
  return new Request('http://localhost/api/recall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown): Promise<{ status: number; body: RecallRouteResponse }> {
  const res = await POST(recall(body));
  return { status: res.status, body: (await res.json()) as RecallRouteResponse };
}

/**
 * A provider that does one thing. The three methods this route never calls
 * throw, so a route that reached for one would fail loudly rather than quietly
 * pass the test.
 */
function providerThat(grade: (entry: Entry, answer: string) => Promise<unknown>): LLMProvider {
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
      [{ answer: 'to plan' }, 'entryId'],
      [{ entryId: 'x' }, 'answer'],
      [{ entryId: 'x', answer: '   ' }, 'answer'],
      [{ entryId: 'x', answer: 'a'.repeat(RECALL_ANSWER_MAX_CHARS + 1) }, 'at most'],
    ] as const) {
      const res = await POST(recall(payload));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { hint: string }).hint).toContain(hint);
    }
  });

  it('drops a sense index it cannot use instead of refusing the answer', () => {
    expect(parseRecallBody({ entryId: 'x', answer: 'to plan', senseIndex: 2 })).toEqual({
      entryId: 'x',
      answer: 'to plan',
      senseIndex: 2,
    });
    for (const senseIndex of [-1, 1.5, '0', null]) {
      expect(parseRecallBody({ entryId: 'x', answer: 'to plan', senseIndex })).toEqual({
        entryId: 'x',
        answer: 'to plan',
      });
    }
  });

  it('is a 404 for an entry this dictionary build does not have', async () => {
    const res = await POST(recall({ entryId: 'bogus|bogus[bo1 gus4]', answer: 'to plan' }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('unknown-entry');
  });
});

describe('the offline grade, end to end', () => {
  it('reads a good answer high and a wrong one as a lapse', async () => {
    const dasuan = entryFor('打算');

    const good = await post({ entryId: dasuan.id, answer: 'to plan or intend to do something' });
    expect(good.status).toBe(200);
    expect(good.body.provider).toBe('fake');
    expect(good.body.suggested).toBe(4);

    const wrong = await post({ entryId: dasuan.id, answer: 'a kind of river fish' });
    expect(wrong.status).toBe(200);
    expect(wrong.body.suggested).toBe(1);

    // Both reasons are prose a learner can read, and neither is Chinese.
    for (const body of [good.body, wrong.body]) {
      expect(body.why.length).toBeGreaterThan(0);
      expect(body.why).not.toMatch(CJK);
    }
  });

  it('judges the sense the card is about when it names one', async () => {
    const dasuan = entryFor('打算');
    // Sense 2 of 打算 is "to calculate"; an answer about planning is not it.
    const senseIndex = dasuan.glosses.findIndex((gloss) => gloss.includes('calculate'));
    expect(senseIndex).toBeGreaterThan(0);

    const narrow = await post({ entryId: dasuan.id, senseIndex, answer: 'to plan' });
    const wide = await post({ entryId: dasuan.id, answer: 'to plan' });
    expect(narrow.body.suggested).toBeLessThan(wide.body.suggested);
  });

  it('answers with one of the four grades and nothing else', async () => {
    const kan = entryFor('看');
    const { body } = await post({ entryId: kan.id, answer: 'to look at, to watch, to read' });
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
    const entry = entryFor('打算');
    const res = await gradeRecallWith(
      providerThat(async () => ({
        suggested: 3,
        why: 'You wrote 打算 (dǎsuàn) — the 计划 sense, roughly right.',
      })),
      entry,
      'to plan',
    );
    const body = (await res.json()) as RecallRouteResponse;

    expect(res.status).toBe(200);
    expect(body.why).not.toMatch(CJK);
    expect(body.why).not.toMatch(/dǎsuàn/);
    expect(body.why).toContain('roughly right');
  });

  it('flattens a reason that runs on into one capped line', async () => {
    const res = await gradeRecallWith(
      providerThat(async () => ({ suggested: 2, why: `line one\nline two ${'x'.repeat(600)}` })),
      entryFor('打算'),
      'to plan',
    );
    const body = (await res.json()) as RecallRouteResponse;
    expect(body.why).not.toContain('\n');
    expect(body.why.length).toBeLessThanOrEqual(320);
  });

  it('is a 502 when the provider throws', async () => {
    const res = await gradeRecallWith(
      providerThat(async () => {
        throw new ProviderError('fake', 'the model refused');
      }),
      entryFor('打算'),
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
        entryFor('打算'),
        'to plan',
      );
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBe('provider-invalid');
    }
  });

  it('is a 502 when the provider hangs past the deadline', async () => {
    const previous = process.env.TANGRAM_RECALL_TIMEOUT_MS;
    process.env.TANGRAM_RECALL_TIMEOUT_MS = '20';
    try {
      const res = await gradeRecallWith(
        providerThat(() => new Promise(() => {})),
        entryFor('打算'),
        'to plan',
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string; hint: string };
      expect(body.error).toBe('provider-failed');
      expect(body.hint).toContain('longer than 20 ms');
    } finally {
      if (previous === undefined) delete process.env.TANGRAM_RECALL_TIMEOUT_MS;
      else process.env.TANGRAM_RECALL_TIMEOUT_MS = previous;
    }
  });
});
