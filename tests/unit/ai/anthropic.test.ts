// @vitest-environment node
// The Anthropic SDK refuses to construct under jsdom (it looks like a browser,
// and a key in a browser is a leaked key). These modules are server-side only.
/**
 * `AnthropicProvider` against a mocked HTTP layer (PLAN.md §3.4, §4 P4).
 *
 * The live API is never called from this container — there is no key here, and
 * the SDK's `fetch` option is injected so nothing can leave the process. What
 * is asserted is the contract: a forced tool call whose input schema is the
 * answer schema, the structured reply parsed out of the `tool_use` block, and
 * every failure arriving as one error type the route can turn into a 502.
 */
import { describe, expect, it } from 'vitest';

import { AnthropicProvider, DEFAULT_MODEL } from '@/lib/ai/anthropic';
import { ANSWER_TOOL_NAME, PROPOSE_TOOL_NAME } from '@/lib/ai/prompts';
import { ProviderError } from '@/lib/ai/provider';
import type { Entry, LearnerProfile } from '@/lib/types';

const PROFILE: LearnerProfile = { estimatedBand: 3, knownSample: ['我', '看'] };

const ENTRY: Entry = {
  id: '打算|打算[da3 suan4]',
  simp: '打算',
  trad: '打算',
  pinyinNum: 'da3 suan4',
  pinyinMarked: 'dǎsuàn',
  glosses: ['to plan', 'to intend'],
  classifiers: ['个'],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 2,
  freqRank: 1200,
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A `fetch` that records the request and answers with the given message. */
function mockFetch(reply: unknown, status = 200): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fake as unknown as typeof fetch, calls };
}

function answerMessage(input: unknown): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_MODEL,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'tool_use', id: 'toolu_1', name: ANSWER_TOOL_NAME, input }],
  };
}

const GOOD_ANSWER = {
  interpretation: 'The verb sense is the one the sentence wants.',
  matches: [{ entryId: ENTRY.id, senseIndex: 0, whyThisOne: 'it is the spoken one' }],
  sayIt: [{ tokens: [{ entryId: ENTRY.id }], en: 'I plan to.', register: 'neutral' }],
  notes: ['a note'],
};

function provider(fetchImpl: typeof fetch): AnthropicProvider {
  return new AnthropicProvider({ apiKey: 'sk-test', fetch: fetchImpl, timeoutMs: 5_000 });
}

describe('the request', () => {
  it('forces the answer tool and carries the derived schema', async () => {
    const { fetch, calls } = mockFetch(answerMessage(GOOD_ANSWER));
    await provider(fetch).answer([ENTRY], PROFILE, 'dasuan', { sentence: '我打算明天去' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toContain('/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-test');

    expect(call.body.model).toBe(DEFAULT_MODEL);
    expect(call.body.tool_choice).toEqual({ type: 'tool', name: ANSWER_TOOL_NAME });

    const tools = call.body.tools as { name: string; input_schema: Record<string, unknown> }[];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(ANSWER_TOOL_NAME);
    // The tool's input schema *is* the answer schema, derived from zod.
    expect(tools[0].input_schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tools[0].input_schema.required).toEqual(['interpretation', 'matches', 'sayIt', 'notes']);

    // The retrieved entry travels as id + glosses; the model is told to cite it.
    const messages = call.body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain(ENTRY.id);
    expect(messages[0].content).toContain('0: to plan');
    expect(messages[0].content).toContain('我打算明天去');
    expect(String(call.body.system)).toContain('never write Chinese characters');
    // No assistant prefill: it is a 400 on this model family.
    expect(messages.some((message) => message.role === 'assistant')).toBe(false);
  });

  it('asks for candidate phrases with its own forced tool', async () => {
    const { fetch, calls } = mockFetch({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: DEFAULT_MODEL,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
      content: [
        {
          type: 'tool_use',
          id: 'toolu_2',
          name: PROPOSE_TOOL_NAME,
          input: { candidates: ['我随便看看', '  ', '我只是看看', 1, 'a', 'b', 'c', 'd', 'e', 'f'] },
        },
      ],
    });

    const { candidates } = await provider(fetch).proposePhrases('how do I say I am just browsing');
    expect(calls[0].body.tool_choice).toEqual({ type: 'tool', name: PROPOSE_TOOL_NAME });
    expect(candidates.slice(0, 2)).toEqual(['我随便看看', '我只是看看']);
    // Junk dropped, and never more than the eight §3.4 allows.
    expect(candidates).not.toContain('  ');
    expect(candidates.length).toBeLessThanOrEqual(8);
  });

  it('sends the model named in the environment', async () => {
    const { fetch, calls } = mockFetch(answerMessage(GOOD_ANSWER));
    const custom = new AnthropicProvider({ apiKey: 'sk-test', fetch, model: 'claude-haiku-4-5' });
    await custom.answer([ENTRY], PROFILE, 'dasuan');
    expect(calls[0].body.model).toBe('claude-haiku-4-5');
  });
});

describe('the response', () => {
  it('parses the forced tool call into an answer', async () => {
    const { fetch } = mockFetch(answerMessage(GOOD_ANSWER));
    const answer = await provider(fetch).answer([ENTRY], PROFILE, 'dasuan');
    expect(answer).toEqual(GOOD_ANSWER);
  });

  it('rejects an answer that does not match the schema', async () => {
    const { fetch } = mockFetch(answerMessage({ interpretation: 'x', matches: 'not an array' }));
    await expect(provider(fetch).answer([ENTRY], PROFILE, 'dasuan')).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects a reply with no tool call in it', async () => {
    const { fetch } = mockFetch({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: DEFAULT_MODEL,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: 'I would rather explain in prose.' }],
    });
    await expect(provider(fetch).answer([ENTRY], PROFILE, 'dasuan')).rejects.toThrow(/tool call/);
  });

  it('turns a refusal into a provider error rather than an empty answer', async () => {
    const { fetch } = mockFetch({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: DEFAULT_MODEL,
      stop_reason: 'refusal',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [],
    });
    await expect(provider(fetch).answer([ENTRY], PROFILE, 'dasuan')).rejects.toThrow(/declined/);
  });

  it('maps an HTTP failure onto one error type, carrying the status', async () => {
    const { fetch } = mockFetch({ type: 'error', error: { type: 'not_found_error', message: 'no such model' } }, 404);
    const error = await provider(fetch)
      .answer([ENTRY], PROFILE, 'dasuan')
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).provider).toBe('anthropic');
    expect((error as ProviderError).status).toBe(404);
  });
});
