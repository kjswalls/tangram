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
 *    come from entries the route returned (or, on a cache hit, from
 *    `/api/dict/entries`) through `renderPhrase` — the ask panel's renderer,
 *    not a second copy of it.
 *  - **The filtering already happened — and a cached row is checked again.**
 *    Every sentence was filtered server-side against the learner's known set
 *    (`lib/ai/examples.ts`), which is where the promise is kept for a fresh
 *    answer. A row out of `ask_cache` is different: its key holds no known set,
 *    and the set shrinks on the most ordinary action in the app (an Add
 *    un-marks the word it was built from). So a cache hit runs the same filter
 *    over the same ids before drawing anything, and a row that no longer passes
 *    is replaced rather than shown.
 *  - **An empty answer is a normal answer.** A learner three days in knows too
 *    few words for a sentence to be buildable out of them. That is one quiet
 *    line, not an error — and it is deliberately not cached, so it fixes itself
 *    as the known set grows.
 */

import { useEffect, useMemo, useState } from 'react';

import type { ExamplesRouteInfo, ExamplesRouteResponse } from '@/app/api/examples/route';
import { examplesCacheKey } from '@/lib/ai/cache-key';
import {
  citedEntryIds,
  filterCachedSentences,
  groundedExamplesSchema,
  knownSet,
  type ExampleSentence,
} from '@/lib/ai/examples';
import { entryLookup, renderPhrase, type PhraseScript } from '@/lib/ai/ground';
import { cn } from '@/lib/cn';
import { getRepository } from '@/lib/db/get-db';
import { fetchEntriesResponse } from '@/lib/dict/client';
import { buildLearnerProfile } from '@/lib/srs/profile';
import type { Entry } from '@/lib/types';

/**
 * Longer than the route's own deadline (20 s), so a slow provider normally
 * comes back as the route's 502 with a reason. This one is the backstop for the
 * network itself: nothing else would ever take the line off the card.
 */
const REQUEST_TIMEOUT_MS = 25_000;

const OFFLINE_NOTE = 'Offline examples — set ANTHROPIC_API_KEY for real sentences.';

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
      provider?: ExamplesRouteInfo['provider'];
      cached: boolean;
    }
  | { status: 'error'; answered: string; message: string };

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
let infoRequest: Promise<ExamplesRouteInfo> | undefined;

const FALLBACK_INFO: ExamplesRouteInfo = { provider: 'fake', promptVersion: 'v1' };

function examplesInfo(): Promise<ExamplesRouteInfo> {
  infoRequest ??= fetch('/api/examples', { headers: { accept: 'application/json' } })
    .then((res) => {
      if (res.ok) return res.json() as Promise<ExamplesRouteInfo>;
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
}

export function ExampleSentences({
  entryId,
  senseIndex,
  script = 'simp',
  className,
}: ExampleSentencesProps) {
  const [state, setState] = useState<State>({ status: 'loading' });

  const requested = requestKey(entryId, senseIndex);

  useEffect(() => {
    if (!entryId) return;
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

        const row = await repo.askCache.get(key).catch(() => undefined);
        const cached = row ? groundedExamplesSchema.safeParse(row.response) : undefined;
        if (cached?.success) {
          // Ids and indexes are all the cache holds, so the dictionary text is
          // fetched fresh rather than redistributed out of IndexedDB.
          const ids = citedEntryIds(cached.data.sentences);
          const resolved =
            ids.length > 0
              ? await fetchEntriesResponse(ids, { signal: controller.signal })
              : { meta: { version: '' }, entries: [] };
          if (cancelled) return;
          // The row is a statement about a known set the key does not hold, so
          // it is re-checked against *today's* — the filter, run again on what
          // is about to be drawn (`filterCachedSentences`). A row that no
          // longer passes is not shown and not repaired: the request below
          // writes a fresh one over it.
          const kept = filterCachedSentences(cached.data.sentences, {
            targetId: entryId,
            entries: resolved.entries,
            set: known,
          });
          if (kept.length > 0) {
            setState({
              status: 'ready',
              answered: requested,
              sentences: kept,
              entries: resolved.entries,
              provider: info.provider,
              cached: true,
            });
            return;
          }
        }

        const res = await fetch('/api/examples', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            entryId,
            ...(senseIndex === undefined ? {} : { senseIndex }),
            profile,
            // Three shapes of one answer to "what does this learner know":
            // headwords for the prompt, ids for the filter, and the band
            // assumption with the cards that outrank it (`knownSet`).
            known: known.headwords,
            knownIds: known.ids,
            knownBand: known.knownBand,
            excludeIds: known.excludeIds,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
            hint?: string;
          } | null;
          const message =
            body?.error === 'dict-data-missing'
              ? 'Dictionary data is missing — run pnpm data.'
              : 'No example sentences for this one right now.';
          if (!cancelled) setState({ status: 'error', answered: requested, message });
          return;
        }

        const body = (await res.json()) as ExamplesRouteResponse;
        // The same three conditions the ask panel writes a row under: the route
        // says this answer is worth keeping, the handshake was real rather than
        // the offline guess, and the provider that answered is the one the key
        // was derived for.
        const trustworthy =
          body.cacheable !== false && info !== FALLBACK_INFO && body.provider === info.provider;
        if (trustworthy) {
          await repo.askCache.set(key, { sentences: body.sentences }).catch(() => undefined);
        }
        if (cancelled) return;
        setState({
          status: 'ready',
          answered: requested,
          sentences: body.sentences,
          entries: body.entries,
          provider: body.provider,
          cached: false,
        });
      } catch (error) {
        if (cancelled || isAbort(error)) return;
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
  }, [entryId, senseIndex, requested]);

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

  return (
    <section
      data-testid="example-sentences"
      data-status={settled?.status ?? 'loading'}
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
                    <span className="hanzi text-xl">{token.text || '?'}</span>
                    <span className="text-xs text-muted">
                      {token.pinyin || '—'}
                      {token.polyphone ? ' · polyphone' : ''}
                    </span>
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
