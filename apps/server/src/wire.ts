/**
 * The edge validator — what a request must look like before it may cost money.
 *
 * `packages/ai/schemas.ts` is the frozen contract and holds **declarations
 * only**: it says so in its own header, and it says why ("a validator is
 * implementation: it decides what a malformed request does, which is B2's
 * remainder to write and to test"). This is that validator.
 *
 * **Why the server validates at all, after the flip.** Until `backend.md` B2 the
 * server held the dictionary and built the prompt from rows it had looked up
 * itself, so body validation was hygiene. Now the client supplies the prompt's
 * inputs, and validation is **cost control**: every field below is either a
 * bound on what the model is asked to read, or the one rule that cannot be
 * expressed as a bound — **the model id is chosen by the server and is never
 * read from a request** (`schemas.ts` rule 2). There is no `model` field on any
 * schema here, and an unknown key is ignored rather than echoed, so a client
 * that names a model names it to nobody.
 *
 * ## Reject or truncate, and which is which
 *
 * The frozen contract draws the line and this module follows it: **counts and
 * byte caps reject with a 400**, because a client that exceeded one has a bug;
 * **`MAX_SENTENCE_CHARS` truncates**, because it bounds a reader selection whose
 * length the learner does not choose. `knownSample` truncates for the same
 * reason the old `parseBody` sliced it — it is a sample, and a sample that is
 * one word too long is not an error.
 *
 * ## Two caps in the frozen contract that are NOT enforced here, and why
 *
 * `MAX_GLOSSES_PER_ENTRY` (12) and `MAX_GLOSS_CHARS` (200) are **below what
 * CC-CEDICT actually produces**, measured against the built artifact rather than
 * assumed: 38 of 124,188 entries carry more than twelve glosses (`白|白[bai2]`
 * carries twenty-one) and the longest single gloss is 496 characters. Enforcing
 * either as a reject would answer 400 to a lookup of 白 — and truncating instead
 * would quietly shorten the prompt for those entries, which is the same class of
 * silent model-behaviour change `backend.md` B2 forbids for `hskBand`.
 *
 * So the gloss volume is bounded by `MAX_BODY_BYTES` instead, which is the cap
 * that was always doing the real work: the **worst possible** 40-entry payload
 * in this dictionary — the forty largest entries there are — serialises to
 * **24.0 KB**, and a typical one to 6.4 KB, against a 256 KB limit. The need for
 * the two numbers to rise (to at least 21 and 512) is recorded in `HANDOFF.md`;
 * this phase does not edit the frozen file to get it.
 *
 * `MAX_HEADWORD_CHARS` and `MAX_ENTRY_ID_CHARS` were measured the same way and
 * both clear the dictionary comfortably (19 against 24, 145 against 160), so
 * they are enforced.
 */

import { z } from 'zod';

import {
  MAX_ENTRY_ID_CHARS,
  MAX_HEADWORD_CHARS,
  MAX_KNOWN_SAMPLE,
  MAX_QUERY_CHARS,
  MAX_RECALL_ANSWER_CHARS,
  MAX_SENTENCE_CHARS,
  MAX_BODY_BYTES,
  RETRIEVED_CAP,
  SUPPORT_CAP,
} from '@tangram/ai/schemas';

/**
 * How long marked pinyin may be.
 *
 * The frozen contract names no cap for it — the one field of `RetrievedEntry`
 * that has none — so this is a local bound rather than a contract value, set
 * from the same measurement as the others: the longest `pinyinMarked` in the
 * built dictionary is 75 characters, and a headword is at most
 * `MAX_HEADWORD_CHARS`. Eight characters of reading per character of headword is
 * the generous side of that by a factor of two. Recorded in `HANDOFF.md`.
 */
export const MAX_PINYIN_CHARS = MAX_HEADWORD_CHARS * 8;

// ---------------------------------------------------------------------------
// Reading the body
// ---------------------------------------------------------------------------

export type BodyResult = { ok: true; value: unknown } | { ok: false; hint: string };

/** Exact UTF-8 size. `String.length` is code units and would under-count hanzi. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Read and parse a JSON body, refusing anything over `MAX_BODY_BYTES`.
 *
 * `content-length` is checked first so an oversized body is refused **before**
 * it is read into memory, and the measured size is checked afterwards so a
 * chunked request with no length header is refused too. A client that lies in
 * the header low and sends more is caught by the second check; one that lies
 * high is refused early, which is the safe direction.
 */
export async function readJsonBody(request: Request, hint: string): Promise<BodyResult> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, hint: `the request body is at most ${MAX_BODY_BYTES} bytes` };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, hint };
  }
  if (byteLength(text) > MAX_BODY_BYTES) {
    return { ok: false, hint: `the request body is at most ${MAX_BODY_BYTES} bytes` };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, hint };
  }
}

/** The one error body a validation failure produces (`ContractErrorCode`). */
export function badRequest(hint: string): Response {
  return Response.json({ error: 'bad-request', hint }, { status: 400 });
}

/** The first issue, as a sentence a caller can act on. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'the request body did not match the contract';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

/**
 * An HSK band, or nothing.
 *
 * Out of range is dropped rather than rejected, which is what `parseBody` did
 * before the flip: the band is a hint about the learner, and refusing an ask
 * because a stale client sent an 8 would be an error where a shrug is right.
 */
const hskBandSchema = z
  .unknown()
  .transform((value) => (typeof value === 'number' ? value : Number.NaN))
  .transform((value) =>
    Number.isInteger(value) && value >= 1 && value <= 7 ? (value as 1 | 2 | 3 | 4 | 5 | 6 | 7) : undefined,
  );

/**
 * One dictionary row as the client sends it.
 *
 * `.strict()` is deliberately **not** used: an unknown key is stripped, not
 * refused. A newer client that grew a field and a server that has not shipped
 * yet is an ordinary state for a product whose mobile shells update
 * independently of this service (`schemas.ts`, on `dictVersion`), and the model
 * only ever sees what `entryLine()` reads.
 */
export const retrievedEntrySchema = z.object({
  id: z.string().min(1).max(MAX_ENTRY_ID_CHARS),
  simp: z.string().min(1).max(MAX_HEADWORD_CHARS),
  trad: z.string().min(1).max(MAX_HEADWORD_CHARS),
  pinyinMarked: z.string().max(MAX_PINYIN_CHARS),
  hskBand: hskBandSchema.optional(),
  // Bounded by MAX_BODY_BYTES rather than by a count — see this file's header.
  glosses: z.array(z.string()),
});

/** Trim, then truncate. `undefined` for anything that is empty after both. */
const sentence = z
  .unknown()
  .transform((value) => (typeof value === 'string' ? value.trim().slice(0, MAX_SENTENCE_CHARS) : ''))
  .transform((value) => (value.length > 0 ? value : undefined));

const finiteNumber = z
  .unknown()
  .transform((value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined,
  );

/**
 * The provenance an ask carries. Every field is optional and every field is
 * cleaned rather than refused, which is what the route did before the flip.
 */
export const askContextSchema = z
  .object({
    sentence: sentence.optional(),
    question: sentence.optional(),
    query: sentence.optional(),
    offset: finiteNumber.optional(),
    length: finiteNumber.optional(),
  })
  .transform((value) => {
    const built = {
      ...(value.sentence === undefined ? {} : { sentence: value.sentence }),
      ...(value.question === undefined ? {} : { question: value.question }),
      ...(value.query === undefined ? {} : { query: value.query }),
      ...(value.offset === undefined ? {} : { offset: value.offset }),
      ...(value.length === undefined ? {} : { length: value.length }),
    };
    return Object.keys(built).length > 0 ? built : undefined;
  });

/**
 * The learner snapshot.
 *
 * Absent is legal and becomes `{ estimatedBand: 1, knownSample: [] }` — the
 * same fallback `app/api/ask/route.ts` applied, and the reason
 * `tests/unit/ai/ask-route.test.ts` can still assert that a bodyless-profile ask
 * answers rather than 400s. `knownSample` truncates at `MAX_KNOWN_SAMPLE`.
 */
export const learnerProfileSchema = z
  .object({
    estimatedBand: hskBandSchema.optional(),
    knownSample: z.array(z.unknown()).optional(),
  })
  .optional()
  .transform((value) => ({
    estimatedBand: value?.estimatedBand ?? (1 as const),
    knownSample: (value?.knownSample ?? [])
      .filter((word): word is string => typeof word === 'string')
      .slice(0, MAX_KNOWN_SAMPLE),
  }));

/** A query, or the recall answer: typed by a person, and rejected over the cap. */
const typedText = (max: number, what: string) =>
  z
    .string({ invalid_type_error: `pass a non-empty { ${what} }` })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, { message: `pass a non-empty { ${what} }` })
    .refine((value) => value.length <= max, { message: `${what} is at most ${max} characters` });

// ---------------------------------------------------------------------------
// The four request bodies
// ---------------------------------------------------------------------------

export const askProposeRequestSchema = z.object({
  query: typedText(MAX_QUERY_CHARS, 'query'),
  context: askContextSchema.optional(),
});

export const askAnswerRequestSchema = z.object({
  query: typedText(MAX_QUERY_CHARS, 'query'),
  context: askContextSchema.optional(),
  profile: learnerProfileSchema,
  /** Declared by the contract, read by nobody here. Bounded so it cannot be a payload. */
  dictVersion: z.string().max(MAX_HEADWORD_CHARS * 4).optional(),
  retrieved: z
    .array(retrievedEntrySchema)
    .max(RETRIEVED_CAP, { message: `at most ${RETRIEVED_CAP} retrieved entries` }),
});

export const examplesRequestSchema = z.object({
  entry: retrievedEntrySchema,
  senseIndex: z.number().int().min(0).optional(),
  profile: learnerProfileSchema,
  support: z
    .array(retrievedEntrySchema)
    .max(SUPPORT_CAP, { message: `at most ${SUPPORT_CAP} support entries` })
    .optional()
    .transform((value) => value ?? []),
});

/**
 * Which gloss the card is about — **dropped rather than rejected**, and the
 * asymmetry with `/api/examples` above is deliberate rather than an oversight.
 *
 * It is what `app/api/recall/route.ts` did before the flip, and its reason is
 * still the reason: "it names which gloss the card is about, and the honest
 * fallback for 'I cannot tell' is to judge the answer against all of them". A
 * free-recall answer with a bad sense index is still an answer worth grading;
 * an examples request with one is a caller that has lost track of which card it
 * is on, and getting sentences about the wrong gloss back is worse than a 400.
 */
const droppedSenseIndex = z
  .unknown()
  .transform((value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined,
  );

export const recallRequestSchema = z.object({
  entry: retrievedEntrySchema,
  senseIndex: droppedSenseIndex.optional(),
  answer: typedText(MAX_RECALL_ANSWER_CHARS, 'answer'),
});

export type AskProposeBody = z.infer<typeof askProposeRequestSchema>;
export type AskAnswerBody = z.infer<typeof askAnswerRequestSchema>;
export type ExamplesBody = z.infer<typeof examplesRequestSchema>;
export type RecallBody = z.infer<typeof recallRequestSchema>;

/**
 * Read a body and validate it in one step, or answer the 400.
 *
 * Returns the parsed value or a `Response`, because every caller does exactly
 * the same thing with a failure and the point of the edge is that no handler
 * can forget to.
 */
export async function parsed<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
  hint: string,
): Promise<{ ok: true; body: z.infer<T> } | { ok: false; response: Response }> {
  const body = await readJsonBody(request, hint);
  if (!body.ok) return { ok: false, response: badRequest(body.hint) };
  // A body that is not an object at all gets the caller's own sentence rather
  // than zod's. `null` parses, so the schema would otherwise answer "Expected
  // object, received null" — true, and useless to whoever is holding the
  // client. This is what every route's `parseBody` said before the flip.
  if (typeof body.value !== 'object' || body.value === null) {
    return { ok: false, response: badRequest(hint) };
  }
  const result = schema.safeParse(body.value);
  if (!result.success) return { ok: false, response: badRequest(firstIssue(result.error)) };
  return { ok: true, body: result.data as z.infer<T> };
}
