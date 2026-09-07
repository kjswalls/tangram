/**
 * The prompts, and the JSON Schema the live provider forces the model into
 * (PLAN.md §3.4).
 *
 * The schema is **derived from the zod schema** in `lib/ai/provider.ts` rather
 * than written twice: a forced tool call is only as good as the agreement
 * between what the model is told to produce and what the parser accepts, and
 * two hand-maintained copies of one contract drift silently.
 *
 * Every derivation happens inside a function. `provider.ts` imports the
 * implementations, which import this file, so a top-level constant here would
 * read `askResponseSchema` before its module body has run.
 */

import type { ZodTypeAny } from 'zod';

import { ASK_PROMPT_VERSION } from '@/lib/ai/cache-key';
import type { AskContext } from '@/lib/ai/provider';
import type { Entry, LearnerProfile } from '@/lib/types';

/** The tool the model is forced to call, so the answer arrives as data. */
export const ANSWER_TOOL_NAME = 'answer_with_citations';
export const PROPOSE_TOOL_NAME = 'propose_phrases';

export const SYSTEM_PROMPT = [
  'You help an English-speaking learner of Mandarin with the question a dictionary cannot answer:',
  'which sense applies here, what register it carries, and what a native speaker would actually say.',
  '',
  'Ground rules, in order of importance:',
  '1. You never write Chinese characters or pinyin in any field. The application renders those from',
  '   the dictionary rows you cite by id. A learner cannot detect a wrong tone — that is why they are',
  '   asking — so an invented headword is the worst thing you can produce.',
  '2. Every entryId you cite must be copied exactly from the RETRIEVED ENTRIES below. Ids you do not',
  '   see there are dropped before the learner sees the answer, and a phrase citing one is discarded',
  '   whole.',
  '3. senseIndex is the 0-based position of the gloss you mean in that entry\'s gloss list.',
  '4. Build "sayIt" out of cited entries in the order they are spoken. Use a {"text": "…"} token only',
  '   when no retrieved entry can carry that part; it is shown to the learner marked as your own',
  '   invention, so prefer citing.',
  '5. "interpretation", "whyThisOne" and "notes" are plain English prose. Say why this sense and not',
  '   the neighbouring one; do not restate the gloss.',
  '6. Pitch the explanation at the learner profile you are given. Prefer words they already know.',
].join('\n');

export const PROPOSE_SYSTEM_PROMPT = [
  'You are a retrieval step, not an answer. Given an English question or sentence from a Mandarin',
  'learner, list the Chinese words or short phrases whose dictionary entries would be needed to answer',
  'it well. Plain simplified Chinese, most likely first, at most 8. No explanation, no pinyin.',
].join('\n');

/** One retrieved entry as the model sees it: id, both scripts, reading, glosses. */
export function entryLine(entry: Entry): string {
  const glosses = entry.glosses.map((gloss, index) => `${index}: ${gloss}`).join(' | ');
  const band = entry.hskBand ? ` HSK${entry.hskBand}` : '';
  return `${entry.id}\t${entry.simp}\t${entry.trad}\t${entry.pinyinMarked}${band}\t${glosses}`;
}

function contextBlock(context: AskContext | undefined): string {
  if (!context) return 'CONTEXT: none — the learner typed this into an empty box.';
  const parts: string[] = [];
  if (context.sentence) parts.push(`sentence: ${context.sentence}`);
  if (context.question) parts.push(`question: ${context.question}`);
  if (context.query) parts.push(`query: ${context.query}`);
  if (context.offset !== undefined && context.length !== undefined) {
    parts.push(`target at offset ${context.offset}, length ${context.length}`);
  }
  return parts.length > 0 ? `CONTEXT:\n${parts.join('\n')}` : 'CONTEXT: none.';
}

function profileBlock(profile: LearnerProfile): string {
  const sample = profile.knownSample.slice(0, 60).join(' ');
  return [
    `LEARNER: around HSK ${profile.estimatedBand}.`,
    sample ? `Words they already know include: ${sample}` : 'No known-word sample yet.',
  ].join('\n');
}

/** The user turn for `answer`. Stable ordering: it is also a cache prefix. */
export function answerUserPrompt(
  retrieved: readonly Entry[],
  profile: LearnerProfile,
  query: string,
  context?: AskContext,
): string {
  return [
    `PROMPT VERSION: ${ASK_PROMPT_VERSION}`,
    profileBlock(profile),
    contextBlock(context),
    '',
    'RETRIEVED ENTRIES (id, simplified, traditional, reading, numbered glosses):',
    retrieved.map(entryLine).join('\n'),
    '',
    `QUESTION: ${query}`,
    '',
    `Call ${ANSWER_TOOL_NAME} exactly once.`,
  ].join('\n');
}

export function proposeUserPrompt(query: string, context?: AskContext): string {
  return [contextBlock(context), '', `QUESTION: ${query}`, '', `Call ${PROPOSE_TOOL_NAME} exactly once.`].join('\n');
}

// ---------------------------------------------------------------------------
// zod → JSON Schema
// ---------------------------------------------------------------------------

/** The JSON Schema subset a tool input needs. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  anyOf?: JsonSchema[];
  minimum?: number;
  minLength?: number;
  /** The SDK's `Tool.InputSchema` is open; keep this assignable to it. */
  [key: string]: unknown;
}

interface ZodDefLike {
  typeName: string;
  description?: string;
  shape?: () => Record<string, ZodTypeAny>;
  type?: ZodTypeAny;
  innerType?: ZodTypeAny;
  options?: ZodTypeAny[];
  value?: unknown;
  checks?: { kind: string; value?: number }[];
  minLength?: { value: number } | null;
}

function defOf(schema: ZodTypeAny): ZodDefLike {
  return schema._def as unknown as ZodDefLike;
}

/**
 * Convert the zod 3 schemas this app uses into JSON Schema. Deliberately
 * narrow: object, array, string, number, boolean, literal, union, optional and
 * nullable are every construct `askResponseSchema` contains, and a schema that
 * grows past them should fail loudly here rather than emit a lie to the model.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  const described = (out: JsonSchema): JsonSchema =>
    def.description ? { ...out, description: def.description } : out;

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const inner = defOf(value);
        const optional = inner.typeName === 'ZodOptional' || inner.typeName === 'ZodDefault';
        properties[key] = zodToJsonSchema(optional && inner.innerType ? inner.innerType : value);
        if (!optional) required.push(key);
      }
      return described({ type: 'object', properties, required, additionalProperties: false });
    }
    case 'ZodArray': {
      const items = def.type ? zodToJsonSchema(def.type) : {};
      const min = def.minLength?.value;
      return described({ type: 'array', items, ...(min ? { minItems: min } : {}) });
    }
    case 'ZodString': {
      const min = def.checks?.find((check) => check.kind === 'min')?.value;
      return described({ type: 'string', ...(min ? { minLength: min } : {}) });
    }
    case 'ZodNumber': {
      const isInt = def.checks?.some((check) => check.kind === 'int') ?? false;
      const min = def.checks?.find((check) => check.kind === 'min')?.value;
      return described({ type: isInt ? 'integer' : 'number', ...(min === undefined ? {} : { minimum: min }) });
    }
    case 'ZodBoolean':
      return described({ type: 'boolean' });
    case 'ZodLiteral':
      return described({ type: typeof def.value === 'number' ? 'number' : 'string' });
    case 'ZodUnion':
      return described({ anyOf: (def.options ?? []).map(zodToJsonSchema) });
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return def.innerType ? zodToJsonSchema(def.innerType) : {};
    default:
      throw new Error(`zodToJsonSchema: unsupported zod type ${def.typeName}`);
  }
}

/**
 * The forced tool. Derived, never hand-written — see the file header for why
 * this is a function rather than a constant.
 */
export function answerTool(schema: ZodTypeAny): {
  name: string;
  description: string;
  input_schema: JsonSchema & { type: 'object' };
} {
  const input = zodToJsonSchema(schema);
  if (input.type !== 'object') throw new Error('answerTool: the answer schema must be an object');
  return {
    name: ANSWER_TOOL_NAME,
    description:
      'Answer the learner’s question about the retrieved dictionary entries. Cite entries by id; never write Chinese characters or pinyin in any field.',
    input_schema: { ...input, type: 'object' },
  };
}

export function proposeTool(): {
  name: string;
  description: string;
  input_schema: JsonSchema & { type: 'object' };
} {
  return {
    name: PROPOSE_TOOL_NAME,
    description: 'List the Chinese words or phrases whose dictionary entries are needed to answer the question.',
    input_schema: {
      type: 'object',
      properties: { candidates: { type: 'array', items: { type: 'string' } } },
      required: ['candidates'],
      additionalProperties: false,
    },
  };
}
