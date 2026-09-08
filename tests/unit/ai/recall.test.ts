/**
 * Free-recall grading, below the UI (PLAN.md §4, Phase 6 item 2).
 *
 * The feature's one rule is that nothing is ever graded for the learner, and
 * the two ways that rule could be broken are both here: a suggestion arriving
 * for a question nobody is asking any more, and a state machine that carries a
 * grade the UI might act on. The rest of the file is the quieter half of the
 * same promise — a failure of any kind is `null`, never a throw and never a
 * shout.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  asRecallSuggestion,
  blankRecall,
  isRecallGrade,
  oneLine,
  recallReducer,
  requestRecallGrade,
  RECALL_ANSWER_MAX_CHARS,
  RECALL_GRADE_VALUES,
  type RecallState,
} from '@/lib/ai/recall';

/** A `fetch` that answers with this body, and records what it was asked. */
function fetchReturning(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  // Rest-typed, so `mock.calls[n]` carries the options object the cases below
  // read the request body back out of.
  return vi.fn(
    async (...args: Parameters<typeof fetch>) =>
      ({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        url: String(args[0]),
        json: async () => body,
      }) as Response,
  );
}

describe('the answer that is never asked about', () => {
  it('does not call the provider for an empty answer', async () => {
    const fetchImpl = fetchReturning({ suggested: 1, why: 'blank' });

    expect(await requestRecallGrade({ entryId: 'x', answer: '' }, { fetchImpl })).toBeNull();
    expect(await requestRecallGrade({ entryId: 'x', answer: '   ' }, { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not call the provider without an entry to judge against', async () => {
    const fetchImpl = fetchReturning({ suggested: 3, why: 'ok' });
    expect(await requestRecallGrade({ entryId: '', answer: 'to plan' }, { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not call the provider when the caller has already given up', async () => {
    const fetchImpl = fetchReturning({ suggested: 3, why: 'ok' });
    const controller = new AbortController();
    controller.abort();
    const result = await requestRecallGrade(
      { entryId: 'x', answer: 'to plan' },
      { fetchImpl, signal: controller.signal },
    );
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('requesting a grade', () => {
  it('sends the trimmed answer, the entry and the sense, and believes a good answer', async () => {
    const fetchImpl = fetchReturning({ suggested: 3, why: 'The gist is there.' });
    const result = await requestRecallGrade(
      { entryId: '打算|打算[da3 suan4]', senseIndex: 1, answer: '  to intend  ' },
      { fetchImpl },
    );

    expect(result).toEqual({ suggested: 3, why: 'The gist is there.' });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/recall');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({
      entryId: '打算|打算[da3 suan4]',
      senseIndex: 1,
      answer: 'to intend',
    });
  });

  it('caps the answer it sends at the same length the route accepts', async () => {
    const fetchImpl = fetchReturning({ suggested: 1, why: '' });
    await requestRecallGrade({ entryId: 'x', answer: 'a '.repeat(600) }, { fetchImpl });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as { answer: string };
    expect(body.answer.length).toBe(RECALL_ANSWER_MAX_CHARS);
  });

  it('omits senseIndex when the card is about the whole entry', async () => {
    const fetchImpl = fetchReturning({ suggested: 4, why: '' });
    await requestRecallGrade({ entryId: 'x', answer: 'to plan' }, { fetchImpl });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).not.toHaveProperty('senseIndex');
  });
});

describe('a failure is silence', () => {
  it('is null for an HTTP error', async () => {
    const fetchImpl = fetchReturning({ error: 'provider-failed' }, { ok: false, status: 502 });
    expect(await requestRecallGrade({ entryId: 'x', answer: 'to plan' }, { fetchImpl })).toBeNull();
  });

  it('is null when the network throws, rather than a rejected promise', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      requestRecallGrade({ entryId: 'x', answer: 'to plan' }, { fetchImpl: fetchImpl as never }),
    ).resolves.toBeNull();
  });

  it('is null when the body is not a grade this app knows', async () => {
    for (const body of [null, {}, { suggested: 0, why: '' }, { suggested: 5, why: '' }, { suggested: '3' }]) {
      const fetchImpl = fetchReturning(body);
      expect(
        await requestRecallGrade({ entryId: 'x', answer: 'to plan' }, { fetchImpl }),
      ).toBeNull();
    }
  });

  it('is null when its own deadline passes, and the wait actually ends', async () => {
    const fetchImpl = vi.fn(
      (...args: Parameters<typeof fetch>) =>
        new Promise<Response>((_resolve, reject) => {
          args[1]?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const started = Date.now();
    const result = await requestRecallGrade(
      { entryId: 'x', answer: 'to plan' },
      { fetchImpl: fetchImpl as never, timeoutMs: 10 },
    );
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('what reaches the card front', () => {
  it('scrubs the reason a second time: no hanzi and no pinyin, whatever the route sent', async () => {
    const fetchImpl = fetchReturning({
      suggested: 4,
      why: 'You said 打算 which is dǎsuàn, the planning sense.',
    });
    const result = await requestRecallGrade({ entryId: 'x', answer: 'to plan' }, { fetchImpl });

    expect(result?.suggested).toBe(4);
    expect(result?.why).not.toMatch(/[一-鿿]/);
    expect(result?.why).not.toMatch(/dǎsuàn/);
    expect(result?.why).toContain('planning sense');
  });

  it('keeps the reason to one line', () => {
    expect(oneLine('  two\n  lines  ')).toBe('two lines');
    expect(oneLine('x'.repeat(50), 10)).toHaveLength(10);
    expect(oneLine('x'.repeat(50), 10).endsWith('…')).toBe(true);
  });

  it('knows the four grades and nothing else', () => {
    expect([...RECALL_GRADE_VALUES]).toEqual([1, 2, 3, 4]);
    for (const grade of RECALL_GRADE_VALUES) expect(isRecallGrade(grade)).toBe(true);
    for (const other of [0, 5, -1, 1.5, '3', null, undefined]) {
      expect(isRecallGrade(other)).toBe(false);
    }
  });

  it('tolerates a missing reason rather than refusing the grade', () => {
    expect(asRecallSuggestion({ suggested: 2 })).toEqual({ suggested: 2, why: '' });
  });

  it('carries who graded it, and only a name it recognises', () => {
    // The box badges the offline grader the way the ask panel and the i+1 block
    // do, so the name has to survive the trip — and an unrecognised one must
    // not, because it decides whether a warning is shown.
    expect(asRecallSuggestion({ suggested: 3, why: 'ok', provider: 'fake' })).toEqual({
      suggested: 3,
      why: 'ok',
      provider: 'fake',
    });
    expect(asRecallSuggestion({ suggested: 3, why: 'ok', provider: 'anthropic' })).toEqual({
      suggested: 3,
      why: 'ok',
      provider: 'anthropic',
    });
    for (const value of ['openai', '', 7, null, undefined]) {
      expect(asRecallSuggestion({ suggested: 3, why: 'ok', provider: value })).toEqual({
        suggested: 3,
        why: 'ok',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The rule the feature is built around
// ---------------------------------------------------------------------------

const SUGGESTION = { suggested: 4, why: 'That reads as recalled.' } as const;
const CARD = 'card-a';
const OTHER = 'card-b';

/** A box that has been submitted and is waiting on request `id`. */
function grading(cardId = CARD, id = 1, answer = 'to plan'): RecallState {
  const typed = recallReducer(blankRecall(cardId), { type: 'type', cardId, answer });
  return recallReducer(typed, { type: 'submit', cardId, requestId: id });
}

describe('the state machine cannot grade a card', () => {
  it('holds no grade to submit — only a suggestion and the answer it judged', () => {
    const state = recallReducer(grading(), {
      type: 'settled',
      cardId: CARD,
      requestId: 1,
      suggestion: SUGGESTION,
    });

    // If a `rating`/`grade`/`submit` field ever appears here, something above
    // it can act on it. That is the failure this test exists to catch.
    expect(Object.keys(state).sort()).toEqual([
      'answer',
      'cardId',
      'failed',
      'phase',
      'requestId',
      'suggestion',
    ]);
    expect(state.phase).toBe('settled');
    expect(state.suggestion).toEqual(SUGGESTION);
    expect(state.answer).toBe('to plan');
  });

  it('ignores a suggestion for a card that has moved on', () => {
    const waiting = grading(CARD, 1);
    // The learner graded that card and started typing into the next one.
    const next = recallReducer(waiting, { type: 'type', cardId: OTHER, answer: 'to look' });
    expect(next.cardId).toBe(OTHER);
    expect(next.phase).toBe('idle');
    expect(next.requestId).toBe(0);

    // The answer to the previous card's question finally arrives.
    const late = recallReducer(next, {
      type: 'settled',
      cardId: CARD,
      requestId: 1,
      suggestion: SUGGESTION,
    });
    expect(late).toBe(next);
    expect(late.suggestion).toBeNull();
  });

  it('ignores every action addressed to another card, typing excepted', () => {
    const idle = blankRecall(CARD);
    expect(recallReducer(idle, { type: 'submit', cardId: OTHER, requestId: 1 })).toBe(idle);
    expect(
      recallReducer(idle, { type: 'settled', cardId: OTHER, requestId: 1, suggestion: SUGGESTION }),
    ).toBe(idle);
  });

  it('ignores a suggestion that is not the one being waited for', () => {
    const waiting = grading(CARD, 7);
    expect(
      recallReducer(waiting, {
        type: 'settled',
        cardId: CARD,
        requestId: 6,
        suggestion: SUGGESTION,
      }),
    ).toBe(waiting);
    const settled = recallReducer(waiting, {
      type: 'settled',
      cardId: CARD,
      requestId: 7,
      suggestion: SUGGESTION,
    });
    expect(settled.suggestion).toEqual(SUGGESTION);
  });

  it('ignores a settlement with no request behind it', () => {
    const waiting = grading();
    expect(
      recallReducer(waiting, { type: 'settled', cardId: CARD, requestId: 0, suggestion: SUGGESTION }),
    ).toBe(waiting);
  });

  it('cannot be settled twice: the second answer changes nothing', () => {
    const settled = recallReducer(grading(), {
      type: 'settled',
      cardId: CARD,
      requestId: 1,
      suggestion: SUGGESTION,
    });
    expect(
      recallReducer(settled, { type: 'settled', cardId: CARD, requestId: 1, suggestion: null }),
    ).toBe(settled);
  });

  it('cannot be edited or re-asked once it has been submitted', () => {
    const waiting = grading();
    expect(recallReducer(waiting, { type: 'type', cardId: CARD, answer: 'to intend' })).toBe(
      waiting,
    );
    expect(recallReducer(waiting, { type: 'submit', cardId: CARD, requestId: 2 })).toBe(waiting);
  });

  it('settles a blank submit without a request, and calls it neither wrong nor failed', () => {
    const state: RecallState = recallReducer(
      recallReducer(blankRecall(CARD), { type: 'type', cardId: CARD, answer: '   ' }),
      { type: 'submit', cardId: CARD, requestId: 0 },
    );
    expect(state.phase).toBe('settled');
    expect(state.requestId).toBe(0);
    expect(state.suggestion).toBeNull();
    expect(state.failed).toBe(false);
  });

  it('records a failure as a failure, quietly', () => {
    const settled = recallReducer(grading(), {
      type: 'settled',
      cardId: CARD,
      requestId: 1,
      suggestion: null,
    });
    expect(settled.failed).toBe(true);
    expect(settled.suggestion).toBeNull();
  });
});
