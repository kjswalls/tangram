/**
 * `/api/examples` — i+1 example sentences for one card, after `backend.md` B2's
 * contract flip.
 *
 *   GET  /api/examples  → { provider, promptVersion, model? }   (unchanged)
 *   POST /api/examples  → { sentences: RawExampleSentence[], …ProviderInfo }
 *
 * The client sends the target entry and the **support pool** — the learner's
 * known words, resolved to dictionary rows, frequency-ordered and already cut to
 * `SUPPORT_CAP`. The server asks the provider for sentences built from those
 * plus the target, validates the shape, and returns them **ungrounded and
 * unfiltered**.
 *
 * **This file used to argue the opposite and the argument has to go with the
 * dictionary.** Its header said: *"step 3 is why this is a route at all rather
 * than a client-side fetch: the filter is the feature, and a filter that ran in
 * the browser would be a promise the server had already broken."* That was true
 * of a server that held the dictionary and a client that did not. After
 * `data.md` the client is the only party that *can* run the filter — it needs
 * the entry rows behind every cited id to decide whether the learner knows them
 * — and the learner is not an adversary to their own flashcards. So the promise
 * is kept where the rows are: `groundExamples()` plus `keepSentence()` run in
 * `apps/app/components/review/example-sentences.tsx`, and nothing unfiltered is
 * ever *drawn*, which is what the promise was always about.
 *
 * What the server still guarantees is the shape and the cost: at most
 * `SUPPORT_CAP` support rows, at most `MAX_EXAMPLE_SENTENCES` sentences back,
 * a bounded body, and a model id it chooses itself.
 *
 * Failure modes: a malformed or oversized body is a 400, and a provider that
 * throws, times out or answers off-schema is a 502. There is no 404 and no 503
 * — this server has no dictionary, so it can neither miss one nor fail to find
 * an id in it.
 */

import { DEFAULT_MODEL } from '@tangram/ai/anthropic';
import { EXAMPLES_PROMPT_VERSION } from '@tangram/ai/cache-key';
import { withDeadline } from '@tangram/ai/deadline';
import {
  exampleSentencesSchema,
  ProviderError,
  selectProvider,
  type LLMProvider,
  type ParsedExampleSentences,
} from '@tangram/ai/provider';
import {
  MAX_EXAMPLE_SENTENCES,
  type AskInfoResponse,
  type ExamplesResponse,
  type LearnerProfile,
  type ProviderInfo,
  type RetrievedEntry,
} from '@tangram/ai/schemas';
import { requireAccess } from '@tangram/access';
import { deadlineMs, modelName } from '../config.ts';
import { redactString } from '../log.ts';
import { examplesRequestSchema, parsed } from '../wire.ts';

/**
 * The learner is mid-review with a grade to press, so the card back gives up
 * sooner than the lookup panel does — 20 s, in `DEADLINE_DEFAULTS`
 * (`src/config.ts`) with the other three.
 */

function info(): ProviderInfo {
  const provider = selectProvider();
  return {
    provider: provider.name,
    promptVersion: EXAMPLES_PROMPT_VERSION,
    ...(provider.name === 'anthropic' ? { model: modelName(DEFAULT_MODEL) } : {}),
  };
}

export interface ExamplesInput {
  entry: RetrievedEntry;
  senseIndex?: number;
  profile: LearnerProfile;
  /** The pool the sentence may be built from. Already capped by the caller. */
  support: readonly RetrievedEntry[];
}

export type ExamplesOutcome =
  | { ok: true; sentences: ParsedExampleSentences['sentences'] }
  | { ok: false; hint: string; invalid?: boolean };

/**
 * The model call, with the provider injected.
 *
 * Exported so the tests can hand it a provider that misbehaves — times out,
 * throws, answers off-schema. What it can no longer be handed is a provider
 * that cites a word the learner does not know, because *this* half no longer
 * judges that: the i+1 filter moved to the client with the dictionary, and its
 * tests moved with it (`tests/unit/ai/examples.test.ts` for the filter,
 * `examples-card.test.tsx` for the card back that runs it).
 */
export async function examplesFor(
  input: ExamplesInput,
  provider: LLMProvider,
): Promise<ExamplesOutcome> {
  let raw: unknown;
  try {
    raw = await withDeadline(
      provider.exampleSentences(input.entry, input.profile, input.senseIndex, input.support),
      deadlineMs('examples'),
      'the sentences',
    );
  } catch (error) {
    const hint =
      error instanceof ProviderError || error instanceof Error
        ? error.message
        : 'the provider failed';
    return { ok: false, hint };
  }

  const result = exampleSentencesSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      invalid: true,
      hint: `the sentences did not match the schema: ${result.error.issues[0]?.message ?? 'unknown'}`,
    };
  }

  return { ok: true, sentences: result.data.sentences.slice(0, MAX_EXAMPLE_SENTENCES) };
}

/**
 * The access gate (`@tangram/access`). A no-op unless `TANGRAM_ACCESS_SECRET`
 * is set; when it is, this route costs money and answers nothing without the
 * `X-Tangram-Access` header. `app.ts` refuses the same request one layer
 * earlier, by prefix; the check staying here is what makes a missing front
 * layer a redundancy rather than a hole.
 */
export function GET(request: Request): Response {
  const denied = requireAccess(request);
  if (denied) return denied;

  const body: AskInfoResponse = info();
  return Response.json(body);
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAccess(request);
  if (denied) return denied;

  const body = await parsed(
    request,
    examplesRequestSchema,
    'send JSON { entry, senseIndex?, profile, support? }',
  );
  if (!body.ok) return body.response;
  const { entry, senseIndex, profile, support } = body.body;

  const provider = selectProvider();
  const outcome = await examplesFor(
    { entry, ...(senseIndex === undefined ? {} : { senseIndex }), profile, support },
    provider,
  );

  if (!outcome.ok) {
    return Response.json(
      {
        error: outcome.invalid ? 'provider-invalid' : 'provider-failed',
        provider: provider.name,
        hint: redactString(outcome.hint),
      },
      { status: 502 },
    );
  }

  const payload: ExamplesResponse = { ...info(), sentences: outcome.sentences };
  return Response.json(payload);
}
