/**
 * The ask endpoints, after `backend.md` B2's contract flip.
 *
 * Before B2 this was one `POST /api/ask` that searched a dictionary held in
 * this process, asked the provider for phrase proposals, segmented them,
 * answered, **grounded**, and returned the answer plus the entries needed to
 * draw it. After B2 the dictionary is on the client (`docs/STACK.md` §2.5), so
 * retrieval and grounding are the client's and what is left here is the model
 * call:
 *
 *   GET  /api/ask          → { provider, promptVersion, model? }   (unchanged)
 *   POST /api/ask/propose  → { candidates, …ProviderInfo }
 *   POST /api/ask/answer   → { response, …ProviderInfo }
 *
 * The split into two POSTs is not a style choice. The model's phrase proposals
 * are an **input** to retrieval, and retrieval now happens in the browser, so
 * the two cannot be one round trip any more. A hanzi query is still one call —
 * the client skips `propose` when `needsProposals()` says the dictionary already
 * answered — and an English question is two.
 *
 * **`response` is schema-validated and NOT grounded**, which is the one thing
 * about this file worth reading twice. `ground()` is what turns a model's ids
 * into something renderable and drops everything it cannot verify; it is pure,
 * it needs the dictionary, and it runs on the client now
 * (`apps/app/lib/ai/ask-client.ts`). `PLAN.md` §3.4 is unchanged by that: every
 * hanzi and every pinyin syllable a learner sees is still rendered from a cited
 * dictionary row, and the party rendering is now the only party holding the
 * rows.
 *
 * What the server keeps is validation, and after the flip validation is **cost
 * control** rather than hygiene — `src/wire.ts` says what that means. The model
 * id in particular is chosen here and never read from a request.
 *
 * Failure modes, all of them answers rather than crashes: a malformed or
 * oversized body is a 400, and a provider that throws, times out or returns
 * something unparseable is a 502 with a hint the panel can show. **There is no
 * 503 `dict-data-missing` any more** — this server has no dictionary, so it
 * cannot have a missing one, and `ContractErrorCode` deliberately does not list
 * that code.
 */

import { withDeadline } from '@tangram/ai/deadline';
import { ASK_PROMPT_VERSION } from '@tangram/ai/cache-key';
import { selectProvider, askResponseSchema, ProviderError } from '@tangram/ai/provider';
import { DEFAULT_MODEL } from '@tangram/ai/anthropic';
import type {
  AskAnswerResponse,
  AskInfoResponse,
  AskProposeResponse,
  ProviderInfo,
} from '@tangram/ai/schemas';
import { requireAccess } from '@tangram/access';
import { deadlineMs, isDevelopment, modelName } from '../config.ts';
import { redactString } from '../log.ts';
import { askAnswerRequestSchema, askProposeRequestSchema, parsed } from '../wire.ts';

/**
 * **How long a provider may take is `src/config.ts`'s** —
 * `DEADLINE_DEFAULTS.askPropose` (8 s) and `.askAnswer` (30 s), the same two
 * numbers and the same two environment variables this file held before B1.
 *
 * A cron is not waiting on these; a person is, with "Thinking about …" on
 * screen and no way out but retyping, so a hung upstream has to become an
 * answer rather than a spinner. The proposal step keeps the short one: it is
 * retrieval help (§3.4), and the client's dictionary search already stands
 * without it — `ask-client.ts` treats a failed `propose` as no candidates and
 * carries on, exactly as the merged route did.
 */

function info(): ProviderInfo {
  const provider = selectProvider();
  return {
    provider: provider.name,
    promptVersion: ASK_PROMPT_VERSION,
    ...(provider.name === 'anthropic' ? { model: modelName(DEFAULT_MODEL) } : {}),
  };
}

/**
 * Turn a provider failure into a 502 the ask panel can show.
 *
 * The hint is redacted rather than suppressed: `core.md`'s panel shows it, and
 * a learner seeing "the model is overloaded" instead of a blank panel is the
 * point. What `redactString` removes is a configured secret's value — a body
 * that never contained one comes back byte-identical. An adversarial reviewer
 * put a real SDK authentication error into a public 502 to show why this is
 * here; suppressing the hint outright would be a behaviour change and is B7's
 * call along with the rest of the operational surface.
 */
function providerFailed(provider: string, error: unknown): Response {
  const message =
    error instanceof ProviderError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'the provider failed';
  return Response.json(
    { error: 'provider-failed', provider, hint: redactString(message) },
    { status: 502 },
  );
}

/**
 * The access gate (`@tangram/access`). A no-op unless `TANGRAM_ACCESS_SECRET`
 * is set in the environment; when it is, these routes cost money and answer
 * nothing without the `X-Tangram-Access` header. `app.ts` refuses the same
 * request one layer earlier, matching the gated paths by PREFIX (`isGatedPath`,
 * `wave-zero.md` §10a) — which is what covers the two paths below, since both
 * sit under `/api/ask`. The check staying in each handler is what makes a
 * missing front layer a redundancy rather than a hole.
 */
export function GET(request: Request): Response {
  const denied = requireAccess(request);
  if (denied) return denied;

  const body: AskInfoResponse = info();
  return Response.json(body);
}

/**
 * `POST /api/ask/propose` — Chinese phrases worth retrieving entries for.
 *
 * The candidates are never displayed. The client segments them against its own
 * dictionary and unions the token entries into the retrieved set, so the model
 * can still only cite words the dictionary has — the same discipline the merged
 * route enforced, one process further along.
 */
export async function PROPOSE(request: Request): Promise<Response> {
  const denied = requireAccess(request);
  if (denied) return denied;

  const body = await parsed(request, askProposeRequestSchema, 'send JSON { query, context? }');
  if (!body.ok) return body.response;
  const { query, context } = body.body;

  const provider = selectProvider();
  let candidates: string[];
  try {
    candidates = (
      await withDeadline(
        provider.proposePhrases(query, context),
        deadlineMs('askPropose'),
        'proposePhrases',
      )
    ).candidates;
  } catch (error) {
    // Unlike `answer`, this one has a defined nothing: the client's dictionary
    // search stands on its own and a failed proposal costs recall, not the
    // answer. It is still reported as a 502 rather than as an empty list —
    // "the model did not suggest anything" and "the model could not be reached"
    // are different facts, and only the caller can decide what to do with the
    // second. `ask-client.ts` decides to carry on.
    if (isDevelopment()) console.warn('proposePhrases failed', error);
    return providerFailed(provider.name, error);
  }

  const payload: AskProposeResponse = { ...info(), candidates };
  return Response.json(payload);
}

/**
 * `POST /api/ask/answer` — the answer, over entries the **client** retrieved.
 *
 * `retrieved` is the whole of what the model may cite. It is capped at
 * `RETRIEVED_CAP` by the edge (`src/wire.ts`) and the cap is enforced here
 * rather than trusted, because after the flip the prompt's size is a caller's
 * choice and the bill is the owner's.
 *
 * The answer comes back **ungrounded**. Everything that decides what a learner
 * actually sees — a citation outside the retrieved set, a sense index past the
 * end of an entry's glosses, a CJK run in prose, a token the model wrote itself
 * — happens on the client, against the dictionary, in `ground()`.
 */
export async function ANSWER(request: Request): Promise<Response> {
  const denied = requireAccess(request);
  if (denied) return denied;

  const body = await parsed(
    request,
    askAnswerRequestSchema,
    'send JSON { query, context?, profile, retrieved }',
  );
  if (!body.ok) return body.response;
  const { query, context, profile, retrieved } = body.body;

  const provider = selectProvider();

  let raw: unknown;
  try {
    raw = await withDeadline(
      provider.answer(retrieved, profile, query, context),
      deadlineMs('askAnswer'),
      'the answer',
    );
  } catch (error) {
    return providerFailed(provider.name, error);
  }

  const parsedAnswer = askResponseSchema.safeParse(raw);
  if (!parsedAnswer.success) {
    return Response.json(
      {
        error: 'provider-invalid',
        provider: provider.name,
        hint: redactString(
          `the answer did not match the schema: ${parsedAnswer.error.issues[0]?.message ?? 'unknown'}`,
        ),
      },
      { status: 502 },
    );
  }

  const payload: AskAnswerResponse = { ...info(), response: parsedAnswer.data };
  return Response.json(payload);
}
