// @vitest-environment node
/**
 * The tool schema is derived from the zod schema, not written beside it
 * (PLAN.md §3.4). These cases are what "derived" has to mean: the shape follows
 * the zod schema, and a change to the zod schema shows up in the JSON Schema
 * without anyone editing a second copy.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { answerTool, answerUserPrompt, entryLine, zodToJsonSchema } from '@/lib/ai/prompts';
import { askResponseSchema } from '@/lib/ai/provider';
import type { Entry, LearnerProfile } from '@/lib/types';

const ENTRY: Entry = {
  id: '打算|打算[da3 suan4]',
  simp: '打算',
  trad: '打算',
  pinyinNum: 'da3 suan4',
  pinyinMarked: 'dǎsuàn',
  glosses: ['to plan', 'to intend'],
  classifiers: [],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 2,
};

describe('zodToJsonSchema', () => {
  it('converts the answer schema into the tool input schema', () => {
    const schema = zodToJsonSchema(askResponseSchema);

    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['interpretation', 'matches', 'sayIt', 'notes']);

    const match = schema.properties?.matches.items;
    expect(match?.properties?.senseIndex).toMatchObject({ type: 'integer', minimum: 0 });
    expect(match?.required).toEqual(['entryId', 'senseIndex', 'whyThisOne']);

    // A sayIt token is one of two shapes, and the union survives the conversion
    // — that is the whole point of citing by id *or* admitting to free text.
    const token = schema.properties?.sayIt.items?.properties?.tokens.items;
    expect(token?.anyOf).toHaveLength(2);
    expect(token?.anyOf?.[0].properties?.entryId).toMatchObject({ type: 'string' });
    expect(token?.anyOf?.[1].properties?.text).toMatchObject({ type: 'string' });
  });

  it('tracks the zod schema rather than a copy of it', () => {
    const extended = askResponseSchema.extend({ confidence: z.number() });
    expect(zodToJsonSchema(extended).required).toContain('confidence');
    // Optional fields are properties but not required.
    const withOptional = askResponseSchema.extend({ hint: z.string().optional() });
    const converted = zodToJsonSchema(withOptional);
    expect(Object.keys(converted.properties ?? {})).toContain('hint');
    expect(converted.required).not.toContain('hint');
  });

  it('refuses a construct it cannot express instead of guessing', () => {
    expect(() => zodToJsonSchema(z.map(z.string(), z.string()))).toThrow(/unsupported/);
  });

  it('is what the answer tool ships', () => {
    const tool = answerTool(askResponseSchema);
    expect(tool.input_schema).toEqual({ ...zodToJsonSchema(askResponseSchema), type: 'object' });
    expect(tool.description).toMatch(/never write Chinese/i);
  });
});

describe('the answer prompt', () => {
  const profile: LearnerProfile = { estimatedBand: 3, knownSample: ['我', '看'] };

  it('numbers the glosses so senseIndex means something', () => {
    expect(entryLine(ENTRY)).toContain('0: to plan | 1: to intend');
    expect(entryLine(ENTRY)).toContain('HSK2');
  });

  it('carries the profile, the context and the question', () => {
    const prompt = answerUserPrompt([ENTRY], profile, 'dasuan', { sentence: '我打算明天去' });
    expect(prompt).toContain('HSK 3');
    expect(prompt).toContain('我打算明天去');
    expect(prompt).toContain('QUESTION: dasuan');
    expect(prompt).toContain(ENTRY.id);
  });

  it('says so when there is no context at all', () => {
    expect(answerUserPrompt([ENTRY], profile, 'dasuan')).toContain('CONTEXT: none');
  });
});
