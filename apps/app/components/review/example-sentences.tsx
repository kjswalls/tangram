'use client';

/**
 * The i+1 sentences on the back of a review card (PLAN.md §4, Phase 6 item 1).
 *
 * Four properties hold it up, and three of them are about staying out of the
 * way:
 *
 *  - **It never blocks the flip.** It mounts *with* the back — the slot only
 *    exists once the card is revealed — and then loads on its own. Pressing
 *    Space shows the reading and the glosses at once; the sentences arrive
 *    after, or do not arrive, and either way the four grade buttons were live
 *    the whole time.
 *  - **It renders nothing the dictionary did not supply.** Hanzi and pinyin
 *    come from entries this device's own dictionary resolved, through
 *    `renderPhrase` — the ask panel's renderer, not a second copy of it.
 *  - **The filtering happens HERE, and a cached row is checked again.** Until
 *    `backend.md` B2 the route filtered: it held the dictionary, so it could.
 *    After the contract flip the server returns the model's sentences
 *    ungrounded and unfiltered, and this component grounds them
 *    (`groundExamples`) and drops every one that cites anything but the target
 *    and the known set. Nothing unfiltered is ever *drawn*, which is what the
 *    promise was always about — and the learner is not an adversary to their
 *    own flashcards. A row out of `ask_cache` is checked a second time on top:
 *    its key holds no known set, and the set shrinks on the most ordinary
 *    action in the app (an Add un-marks the word it was built from), so a row
 *    that no longer passes is replaced rather than shown.
 *  - **An empty answer is a normal answer.** A learner three days in knows too
 *    few words for a sentence to be buildable out of them. That is one quiet
 *    line, not an error — and it is deliberately not cached, so it fixes itself
 *    as the known set grows.
 */

import { useEffect, useMemo, useState } from 'react';

import { HanziWord } from '@/components/hanzi/hanzi-text';
import { examplesCacheKey } from '@tangram/ai/cache-key';
import {
  citedEntryIds,
  groundExamples,
  groundedExamplesSchema,
  type ExampleSentence,
} from '@tangram/ai/examples';
import { withStoreContext } from '@tangram/ai/retrieve';
import {
  EXAMPLES_PATH,
  toRetrieved,
  type AskInfoResponse,
  type ExamplesResponse,
} from '@tangram/ai/schemas';
// The learner's known set is browser-side and left `packages/ai` in
// `backend.md` B1 — see `lib/srs/known-set.ts`. `offeredSupport` joined it in
// B2: resolving the known set into dictionary rows is the client's now.
import {
  allowedEntryIds,
  filterCachedSentences,
  knownSet,
  offeredSupport,
} from '@/lib/srs/known-set';
import { entryLookup, renderPhrase, type PhraseScript } from '@tangram/ai/ground';
import { cn } from '@/lib/cn';
import { getRepository } from '@/lib/db/get-db';
import { openDictStore } from '@/lib/dict/browser-store';
import { buildLearnerProfile } from '@/lib/srs/profile';

import type { Entry } from '@/lib/types';

// `apiFetch`, not `fetch` (docs/plans/web.md W4). It applies the configured
// API base and attaches `X-Tangram-Access`; without it this call 401s on any
// deployment with `TANGRAM_ACCESS_SECRET` set, and goes to the wrong origin
// once `backend.md` moves the route off this one.
import { API_CONFIGURED, apiFetch } from '@/src/access/client';
import { apiProblemOf, responseProblem } from '@/lib/api/availability';
import { Button } from '@/components/ui/button';
import { withDevHint } from '@/lib/dev-hint';

/**
 * Longer than the route's own deadline (20 s), so a slow provider normally
 * comes back as the route's 502 with a reason. This one is the backstop for the
 * network itself: nothing else would ever take the line off the card.
 */
const REQUEST_TIMEOUT_MS = 25_000;

const OFFLINE_NOTE = withDevHint('Offline examples', ' — set ANTHROPIC_API_KEY for real sentences') + '.';

/** No API in this build. Permanent, so there is no retry beside it. */
export const EXAMPLES_NOT_CONFIGURED =
  'Example sentences are not set up in this version of the app.';
/** A base is set and nothing answered. Transient, so it comes with one. */
export const EXAMPLES_UNREACHABLE = 'Could not reach the server for example sentences.';

/**
 * Every settled state records **what it answers** (`answered`), and staleness is
 * derived in render rather than reset in an effect. Two reasons: a setState in
 * the body of an effect is a cascading render (and a lint error), and a card
 * whose entry changed under the component must not read its predecessor's
 * sentences under its own hanzi for as long as the fetch takes.
 */
type State =
  | { status: 'loading' }
  | {
      status: 'ready';
      answered: string;
      sentences: ExampleSentence[];
      entries: Entry[];
      provider?: AskInfoResponse['provider'];
      cached: boolean;
    }
  | {
      status: 'error';
      answered: string;
      message: string;
      /** Nothing answered at all — the one failure a retry can fix. */
      unreachable?: boolean;
    };

/** What a state answers: the entry, and the sense of it the card is about. */
function requestKey(entryId: string | null, senseIndex?: number): string {
  return `${entryId ?? ''}#${senseIndex ?? ''}`;
}

/**
 * Which provider is live and under which prompt version — two of the parts of
 * the cache key, so the client has to know them before it can look in the
 * cache. Memoised per page load; a *failed* handshake is never memoised, or one
 * transient error would key every later row under a guessed provider.
 */
let infoRequest: Promise<AskInfoResponse> | undefined;

const FALLBACK_INFO: AskInfoResponse = { provider: 'fake', promptVersion: 'v1' };

function examplesInfo(): Promise<AskInfoResponse> {
  infoRequest ??= apiFetch(EXAMPLES_PATH, { headers: { accept: 'application/json' } })
    .then((res) => {
      if (res.ok) return res.json() as Promise<AskInfoResponse>;
      infoRequest = undefined;
      return FALLBACK_INFO;
    })
    .catch(() => {
      infoRequest = undefined;
      return FALLBACK_INFO;
    });
  return infoRequest;
}

/** Test seam: the handshake is memoised for the life of the page, not the suite. */
export function resetExamplesInfo(): void {
  infoRequest = undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export interface ExampleSentencesProps {
  /** The entry the card is about. Phrase cards have none, and get nothing. */
  entryId: string | null;
  /** The gloss the card is about, when it has one — it changes the sentences. */
  senseIndex?: number;
  /**
   * The learner's script preference, from the same settings row the card front
   * reads (`cardFace`). A traditional card front over simplified sentences is
   * the app answering a preference on one half of the card.
   */
  script?: PhraseScript;
  className?: string;
  /**
   * Whether this build has an API (`API_CONFIGURED`). A prop only so the unit
   * tests can draw the not-configured state without a second build.
   */
  configured?: boolean;
}

export function ExampleSentences({
  entryId,
  senseIndex,
  script = 'simp',
  className,
  configured = API_CONFIGURED,
}: ExampleSentencesProps) {
  const [state, setState] = useState<State>({ status: 'loading' });
  /** Bumped by the unreachable line's retry, which re-runs the request effect. */
  const [attempt, setAttempt] = useState(0);

  const requested = requestKey(entryId, senseIndex);

  useEffect(() => {
    // No API in this build: nothing to ask, so nothing is read, opened or sent.
    // The line below is drawn from the prop alone.
    if (!entryId || !configured) return;
    let cancelled = false;
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new DOMException('timeout', 'TimeoutError')),
      REQUEST_TIMEOUT_MS,
    );

    const run = async (): Promise<void> => {
      try {
        const repo = getRepository();
        // One pass over the database for both. The profile describes the
        // learner to the model and the known headwords are what a sentence may
        // be built from; they are two readings of the same three tables, so
        // they share one read and go through the pure builders rather than
        // calling `getLearnerProfile` and `getKnownHeadwords` for six.
        const [info, settings, cards, knownIds] = await Promise.all([
          examplesInfo(),
          repo.getSettings(),
          repo.allCards(),
          repo.knownEntryIds(),
        ]);
        if (cancelled) return;
        const profile = buildLearnerProfile({
          settings,
          cards,
          known: knownIds.map((id) => ({ entryId: id })),
        });
        const known = knownSet({ settings, cards, known: knownIds });

        const key = await examplesCacheKey({
          entryId,
          ...(senseIndex === undefined ? {} : { senseIndex }),
          estimatedBand: profile.estimatedBand,
          provider: info.provider,
          promptVersion: info.promptVersion,
        });

        // The dictionary, opened here rather than assumed.
        //
        // `openDictStore`, not `getDictStore` (`data.md` D6): the card back is
        // not behind `<DictGate>` — Practice is the learner's own data and must
        // work without a dictionary — so this is one of the two places that has
        // to open it itself.
        //
        // **What `backend.md` B2 changed, and it is a real consequence rather
        // than a detail.** Before the flip this whole feature worked on a device
        // with no dictionary, because the server retrieved, grounded, filtered
        // and returned the rows to draw. After the flip every one of those is
        // this component's, and each needs the dictionary: there is no way to
        // render a cited id as hanzi without the row behind it. So a device that
        // has not downloaded the dictionary gets the quiet "not enough known
        // words yet" line rather than sentences. That is inherent to grounding
        // on the client and is recorded in `HANDOFF.md`; it is deliberately not
        // an error state, because nothing is broken and the four grade buttons
        // were live the whole time.
        const store = await openDictStore().catch(() => undefined);
        if (cancelled) return;
        if (!store) {
          // The quiet failure line, not the "not enough known words yet" one.
          // The empty state names a *reason* — the learner's vocabulary — and
          // that reason would be false here: the words may well be there and
          // this device simply cannot check them. "No example sentences for
          // this one right now" claims nothing it cannot stand behind.
          setState({
            status: 'error',
            answered: requested,
            message: 'No example sentences for this one right now.',
          });
          return;
        }

        const row = await repo.askCache.get(key).catch(() => undefined);
        const cached = row ? groundedExamplesSchema.safeParse(row.response) : undefined;
        if (cached?.success) {
          // Ids and indexes are all the cache holds, so the dictionary text is
          // read fresh rather than redistributed out of IndexedDB.
          const ids = citedEntryIds(cached.data.sentences);
          const entries = ids.length > 0 ? await store.entries(ids) : [];
          if (cancelled) return;
          // The row is a statement about a known set the key does not hold, so
          // it is re-checked against *today's* — the filter, run again on what
          // is about to be drawn (`filterCachedSentences`). A row that no
          // longer passes is not shown and not repaired: the request below
          // writes a fresh one over it.
          const kept = filterCachedSentences(cached.data.sentences, {
            targetId: entryId,
            entries,
            set: known,
          });
          if (kept.length > 0) {
            setState({
              status: 'ready',
              answered: requested,
              sentences: kept,
              entries,
              provider: info.provider,
              cached: true,
            });
            return;
          }
        }

        // Retrieval, on this device (`backend.md` B2). The target row and the
        // support pool — the learner's known words as dictionary rows,
        // frequency-ordered and cut to `SUPPORT_CAP` — are what the prompt is
        // built from, and after the flip the client is the party that has them.
        const [target] = await store.entries([entryId]);
        if (cancelled) return;
        if (!target) {
          // The card names an entry this dictionary build does not have — a
          // CC-CEDICT rebuild retires a content-derived id. It is the same
          // outcome the route's old 404 produced on the client, and for the
          // same reason it is the failure line rather than the empty state: the
          // learner's known set is not why. The card itself renders from its
          // own snapshot and is unaffected.
          setState({
            status: 'error',
            answered: requested,
            message: 'No example sentences for this one right now.',
          });
          return;
        }
        const offered = await offeredSupport(
          store,
          {
            headwords: known.headwords,
            ids: known.ids,
            knownBand: known.knownBand,
            excludeIds: known.excludeIds,
          },
          target.id,
        );
        if (cancelled) return;

        // The one call whose failure means "nothing answered", caught on its
        // own: a `TypeError` from grounding a malformed body further down is
        // a server that answered, and must not be read as unreachable.
        let res: Response;
        try {
          res = await apiFetch(EXAMPLES_PATH, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              // `toRetrieved`, not the rows themselves: assignability is a
              // compile-time fact and `JSON.stringify` is not, so without it every
              // one of the fourteen `Entry` fields would go on the wire.
              entry: toRetrieved(target),
              ...(senseIndex === undefined ? {} : { senseIndex }),
              profile,
              support: offered.map(toRetrieved),
            }),
          });
        } catch (error) {
          if (cancelled || isAbort(error)) return;
          const unreachable = apiProblemOf(error) === 'unreachable';
          setState({
            status: 'error',
            answered: requested,
            message: unreachable
              ? EXAMPLES_UNREACHABLE
              : 'No example sentences for this one right now.',
            ...(unreachable ? { unreachable: true } : {}),
          });
          return;
        }
        if (!res.ok) {
          // A static host's 404 or a proxy's 5xx is "nothing answered" too;
          // the API's own refusal carries its error shape and is not.
          const refused = await res.json().catch(() => null);
          const unreachable = responseProblem(res.status, refused) === 'unreachable';
          if (!cancelled) {
            setState({
              status: 'error',
              answered: requested,
              message: unreachable
                ? EXAMPLES_UNREACHABLE
                : 'No example sentences for this one right now.',
              ...(unreachable ? { unreachable: true } : {}),
            });
          }
          return;
        }

        const body = (await res.json()) as ExamplesResponse;

        // Grounding and the i+1 filter, both here now. `groundExamples` is
        // `packages/ai/examples.ts` unchanged — the same function the route ran
        // — and `withStoreContext` is the seam that drives a pure synchronous
        // `ground()` over an asynchronous `DictStore`. `retrieved` is the target
        // plus the pool, so a citation the client never offered is dropped
        // before anything is drawn; `allowed` is the narrower set a sentence may
        // be *shown* citing, and the two are enforced separately for the reason
        // the route stated: the day a wider pool is offered, the promise on the
        // card back must not quietly widen with it.
        const sentences = await withStoreContext(store, [target, ...offered], (context) =>
          groundExamples(
            { sentences: body.sentences },
            context,
            { targetId: target.id, allowed: allowedEntryIds(offered, known) },
          ),
        );
        if (cancelled) return;

        const entries = await store.entries(citedEntryIds(sentences));

        // The same three conditions the ask panel writes a row under, with the
        // first one now computed here: an empty result is never cached (it is a
        // statement about how many words the learner knew today, and only this
        // side knows that), the handshake was real rather than the offline
        // guess, and the provider that answered is the one the key was derived
        // for.
        const trustworthy =
          sentences.length > 0 && info !== FALLBACK_INFO && body.provider === info.provider;
        if (trustworthy) {
          await repo.askCache.set(key, { sentences }).catch(() => undefined);
        }
        if (cancelled) return;
        setState({
          status: 'ready',
          answered: requested,
          sentences,
          entries,
          provider: body.provider,
          cached: false,
        });
      } catch (error) {
        if (cancelled || isAbort(error)) return;
        // Everything after the response arrived — a body that would not
        // parse or ground, a dictionary read. The server answered, so this
        // is the quiet line, never the unreachable one: see the fetch above.
        setState({
          status: 'error',
          answered: requested,
          message: 'No example sentences for this one right now.',
        });
      }
    };

    void run();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(deadline);
    };
  }, [entryId, senseIndex, requested, configured, attempt]);

  // Anything answering a different entry is not an answer to this one yet.
  const settled = state.status !== 'loading' && state.answered === requested ? state : undefined;
  const ready = settled?.status === 'ready' ? settled : undefined;
  const failed = settled?.status === 'error' ? settled : undefined;
  const lookup = useMemo(() => entryLookup(ready?.entries ?? []), [ready?.entries]);
  const rendered = useMemo(
    () =>
      ready
        ? ready.sentences
            .map((sentence) => renderPhrase(sentence, lookup, script))
            // Last gate, and the only one that sees what is actually about to be
            // painted. `renderPhrase` ORs the phrase flag with every token's
            // `unverified` and `missing`, so this drops a sentence whose cited
            // entry no longer resolves — which would otherwise draw a `?` and a
            // `—` mid-sentence under a heading that promises the opposite. The
            // empty line below is the honest answer when it empties the list.
            .filter((phrase) => !phrase.unverified)
        : [],
    [ready, lookup, script],
  );

  // A phrase card has no single entry behind it, so there is nothing to build a
  // sentence *about*. Nothing is rendered at all — not an empty state.
  if (!entryId) return null;

  /**
   * **No API in this build.** One muted line where the sentences would be, from
   * the first paint — no "Building a sentence…", because nothing is being
   * built. It sits on the card back under the answer, so it never interrupts
   * a review; the grade buttons were live the whole time either way.
   */
  if (!configured) {
    return (
      <section
        data-testid="example-sentences"
        data-status="error"
        data-api="not-configured"
        className={cn('flex flex-col gap-2', className)}
      >
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
          Sentences from words you know
        </h3>
        <p data-testid="examples-status" className="text-sm text-muted">
          {EXAMPLES_NOT_CONFIGURED}
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="example-sentences"
      data-status={settled?.status ?? 'loading'}
      data-api={failed?.unreachable ? 'unreachable' : 'ok'}
      data-provider={ready?.provider ?? 'unknown'}
      data-cached={ready?.cached ? 'true' : 'false'}
      className={cn('flex flex-col gap-2', className)}
    >
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
        Sentences from words you know
      </h3>

      {settled === undefined ? (
        <p data-testid="examples-status" className="text-sm text-muted">
          Building a sentence from words you know…
        </p>
      ) : null}

      {failed ? (
        <p data-testid="examples-status" className="text-sm text-muted">
          {failed.message}
        </p>
      ) : null}

      {failed?.unreachable ? (
        <Button
          data-testid="examples-retry"
          variant="secondary"
          size="sm"
          className="self-start"
          // Keyboard grading reads 1–4 and Space off the window; a click here
          // must not leave focus on a button that Space would press again.
          onClick={(event) => {
            event.currentTarget.blur();
            setState({ status: 'loading' });
            setAttempt((count) => count + 1);
          }}
        >
          Try again
        </Button>
      ) : null}

      {ready && rendered.length === 0 ? (
        <p data-testid="examples-empty" className="text-sm text-muted">
          Not enough known words yet to build a sentence around this one — as your known words
          grow, sentences will appear here.
        </p>
      ) : null}

      {rendered.length > 0 ? (
        <ul data-testid="examples-list" className="flex flex-col gap-3">
          {rendered.map((sentence, index) => (
            <li
              key={`${sentence.zh}-${index}`}
              data-testid="example-sentence"
              className="rounded-lg border border-border px-3 py-2"
            >
              <p className="flex flex-wrap items-end gap-x-2 gap-y-1">
                {sentence.tokens.map((token, position) => (
                  <span
                    key={`${token.entryId ?? token.text}-${position}`}
                    data-testid="example-token"
                    data-entry-id={token.entryId ?? ''}
                    data-polyphone={token.polyphone ? 'true' : undefined}
                    className="flex flex-col items-center"
                    // The same hint the ask panel gives a cited polyphone
                    // (§3.4): these characters have more than one reading, and
                    // the one under them is the one the sentence means.
                    title={
                      token.polyphone
                        ? 'This character has more than one reading — the one shown is the one this sentence uses.'
                        : undefined
                    }
                  >
                    {/*
                      The reading is ABOVE the token now, through the same
                      `<HanziText>` every other Chinese run goes through.
                      **It is still token-granular, not character-granular**,
                      and that is a frozen-surface limit rather than a choice:
                      `RenderedToken` (lib/ai/ground.ts) carries `pinyin` as the
                      MARKED word-level form, and `alignReading` needs the
                      NUMBERED one. Adding `pinyinNum` to that token is the
                      change C3 would need and did not make — recorded in
                      HANDOFF.md. Until then the run aligns in `fallback` mode,
                      which renders exactly one annotation over the token: the
                      correct word-level reading rather than a guessed
                      per-character one.
                    */}
                    <HanziWord
                      text={token.text || '?'}
                      {...(token.pinyin ? { pinyinMarked: token.pinyin } : {})}
                      className="text-xl"
                      force
                    />
                    {token.polyphone ? (
                      <span className="text-xs text-muted">polyphone</span>
                    ) : null}
                  </span>
                ))}
              </p>
              <p data-testid="example-en" className="mt-1 text-sm text-muted">
                {sentence.en}
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      {ready?.provider === 'fake' ? (
        <p data-testid="examples-offline" className="text-xs text-warning">
          {OFFLINE_NOTE}
        </p>
      ) : null}
    </section>
  );
}
