/**
 * `AnthropicProvider` (PLAN.md §3.4) — wired, typed, unit-tested against a
 * mocked HTTP layer, and **never called live from this container**. There is no
 * key here; `selectProvider` hands back the fake unless both
 * `TANGRAM_LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are set.
 *
 * Structured output by **forced tool call**: the answer schema is the tool's
 * input schema (derived from the zod schema in `lib/ai/provider.ts`), and
 * `tool_choice: {type:'tool', name}` makes the model call it. The reply is
 * parsed out of the `tool_use` block and re-parsed through zod — the tool
 * schema is a strong prior, not a guarantee, and `ground()` downstream trusts
 * the shape.
 *
 * Written against the `claude-api` skill: model id `claude-opus-5` (no date
 * suffix), thinking left at the model default, typed SDK errors, timeout in
 * **milliseconds**, and no assistant prefill (rejected on this model family).
 */

import Anthropic from '@anthropic-ai/sdk';

import {
  ANSWER_TOOL_NAME,
  PROPOSE_TOOL_NAME,
  PROPOSE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  answerTool,
  answerUserPrompt,
  proposeTool,
  proposeUserPrompt,
} from '@/lib/ai/prompts';
import {
  MAX_PROPOSED_PHRASES,
  ProviderError,
  askResponseSchema,
  type AskContext,
  type LLMProvider,
  type ParsedAskResponse,
  type ProposedPhrases,
} from '@/lib/ai/provider';
import type { Entry, LearnerProfile } from '@/lib/types';

/**
 * Recorded in `.env.example` as the default for `TANGRAM_MODEL`. Opus 5 is the
 * current default model; `claude-haiku-4-5` would do for the proposal step if
 * the ask ever needs to be cheaper, but one model means one prompt cache.
 */
export const DEFAULT_MODEL = 'claude-opus-5';

/** Generous for a structured answer, short enough that a hung call is not a hung page. */
export const REQUEST_TIMEOUT_MS = 45_000;
export const MAX_TOKENS = 16_000;

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Injected in tests; the SDK calls it in place of global `fetch`. */
  fetch?: ClientOptionsFetch;
  /** Injected in tests, when a whole client is easier to fake than a fetch. */
  client?: MessagesClient;
}

type ClientOptionsFetch = NonNullable<ConstructorParameters<typeof Anthropic>[0]>['fetch'];

/** The one method of the SDK this provider uses, so a test can supply it. */
export interface MessagesClient {
  messages: {
    create: (
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number },
    ) => Promise<Anthropic.Message>;
  };
}

function toolInput(message: Anthropic.Message, name: string): unknown {
  for (const block of message.content) {
    if (block.type === 'tool_use' && block.name === name) return block.input;
  }
  return undefined;
}

/** Map an SDK failure onto one error type the route can turn into a 502. */
function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    return new ProviderError('anthropic', `${error.name}: ${error.message}`, status);
  }
  if (error instanceof Error) return new ProviderError('anthropic', error.message);
  return new ProviderError('anthropic', 'unknown provider failure');
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  private readonly client: MessagesClient;
  private readonly timeoutMs: number;

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        timeout: this.timeoutMs,
        maxRetries: 1,
      });
  }

  async proposePhrases(query: string, context?: AskContext): Promise<ProposedPhrases> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: PROPOSE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: proposeUserPrompt(query, context) }],
          tools: [proposeTool()],
          tool_choice: { type: 'tool', name: PROPOSE_TOOL_NAME },
        },
        { timeout: this.timeoutMs },
      );
    } catch (error) {
      throw asProviderError(error);
    }

    const input = toolInput(message, PROPOSE_TOOL_NAME);
    const raw = (input as { candidates?: unknown } | undefined)?.candidates;
    if (!Array.isArray(raw)) return { candidates: [] };
    return {
      candidates: raw
        .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
        .map((candidate) => candidate.trim())
        .slice(0, MAX_PROPOSED_PHRASES),
    };
  }

  async answer(
    retrieved: readonly Entry[],
    profile: LearnerProfile,
    query: string,
    context?: AskContext,
  ): Promise<ParsedAskResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: answerUserPrompt(retrieved, profile, query, context) }],
          tools: [answerTool(askResponseSchema)],
          tool_choice: { type: 'tool', name: ANSWER_TOOL_NAME },
        },
        { timeout: this.timeoutMs },
      );
    } catch (error) {
      throw asProviderError(error);
    }

    if (message.stop_reason === 'refusal') {
      throw new ProviderError('anthropic', 'the model declined to answer this question');
    }

    const input = toolInput(message, ANSWER_TOOL_NAME);
    if (input === undefined) {
      throw new ProviderError('anthropic', `no ${ANSWER_TOOL_NAME} tool call in the response`);
    }

    const parsed = askResponseSchema.safeParse(input);
    if (!parsed.success) {
      throw new ProviderError('anthropic', `the answer did not match the schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }
    return parsed.data;
  }
}
