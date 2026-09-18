// @vitest-environment node
/**
 * The tool schema is derived from the zod schema, not written beside it
 * (PLAN.md §3.4). These cases are what "derived" has to mean: the shape follows
 * the zod schema, and a change to the zod schema shows up in the JSON Schema
 * without anyone editing a second copy.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  answerTool,
  answerUserPrompt,
  entryLine,
  examplesUserPrompt,
  recallUserPrompt,
  zodToJsonSchema,
} from '@tangram/ai/prompts';
import { askResponseSchema } from '@tangram/ai/provider';
import { ASK_PROMPT_VERSION } from '@tangram/ai/cache-key';
import { toRetrieved, type RetrievedEntry } from '@tangram/ai/schemas';
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

describe('the HSK band survives the wire', () => {
  /**
   * **`backend.md` B2's fourth acceptance criterion, as a test.**
   *
   * `entryLine` renders `id \t simp \t trad \t pinyinMarked[ HSK<band>] \t
   * glosses`, and the same function feeds `/api/examples`' TARGET block and
   * `/api/recall`'s THE WORD block. After the contract flip the client sends a
   * six-field `RetrievedEntry` rather than a fifteen-field `Entry`, and dropping
   * `hskBand` from that projection would have changed every prompt containing a
   * banded entry — a model-behaviour change smuggled in as a transport decision,
   * in the one phase whose purpose is that the review has a single variable.
   *
   * So the band is pinned in all three prompts, from a `RetrievedEntry` rather
   * than from an `Entry`: what is under test is the shape that actually travels.
   */
  const profile: LearnerProfile = { estimatedBand: 3, knownSample: [] };
  const banded: RetrievedEntry = toRetrieved(ENTRY);
  const unbanded: RetrievedEntry = {
    id: '随便|随便[sui2 bian4]',
    simp: '随便',
    trad: '隨便',
    pinyinMarked: 'suíbiàn',
    glosses: ['as one wishes'],
  };

  it('renders the band for an entry that has one, and nothing for one that does not', () => {
    expect(entryLine(banded)).toContain(' HSK2');
    expect(entryLine(unbanded)).not.toContain('HSK');
    // `backend.md` B2's criterion names band 3 literally, and every band is
    // rendered the same way — so the loop is the assertion rather than one
    // fixture that happens to be the number in the plan.
    for (const hskBand of [1, 2, 3, 4, 5, 6, 7] as const) {
      expect(entryLine({ ...unbanded, hskBand })).toContain(` HSK${hskBand}`);
    }
    // The line is exactly the six fields and nothing else.
    expect(entryLine(unbanded)).toBe(
      '随便|随便[sui2 bian4]\t随便\t隨便\tsuíbiàn\t0: as one wishes',
    );
  });

  it('keeps it in all three prompts the wire feeds', () => {
    expect(answerUserPrompt([banded], profile, 'dasuan')).toContain(' HSK2');
    expect(examplesUserPrompt(banded, profile)).toContain(' HSK2');
    expect(recallUserPrompt(banded, 'to plan')).toContain(' HSK2');
  });

  it('is byte-identical to the prompt a whole Entry produced', () => {
    // The projection is a narrowing of what `entryLine` already read, so a
    // prompt built from a `RetrievedEntry` and one built from the `Entry` it
    // came from are the same string. This is what makes "no prompt text changed
    // in this phase" checkable rather than asserted, and therefore why
    // `ASK_PROMPT_VERSION` is not bumped.
    expect(entryLine(toRetrieved(ENTRY))).toBe(entryLine(ENTRY));
    expect(answerUserPrompt([toRetrieved(ENTRY)], profile, 'dasuan')).toBe(
      answerUserPrompt([ENTRY], profile, 'dasuan'),
    );
    expect(ASK_PROMPT_VERSION).toBe('v1');
  });
});
