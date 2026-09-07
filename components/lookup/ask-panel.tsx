'use client';

/**
 * The ask panel (PLAN.md §3.4) — the half of the lookup answer a dictionary
 * structurally cannot give: which sense applies *here*, what a native would
 * actually say, and one tap to a card that remembers the question.
 *
 * Three properties hold it up:
 *
 *  - **It never blocks the dictionary.** It mounts into the panel's ask slot,
 *    debounces, and loads on its own; a slow or failing provider leaves the
 *    entry body untouched. Its own failure is a line of text, not a blank.
 *  - **It renders nothing the dictionary did not supply.** Hanzi and pinyin
 *    come from the entries the route returned (or, on a cache hit, from
 *    `/api/dict/entries`), through `renderPhrase`. The model's own strings are
 *    visibly marked, and so is anything grounding could not verify.
 *  - **It checks the cache before it asks.** `askCacheKey` is derivable in the
 *    browser precisely so this can happen client-side; a repeat question with
 *    the same context costs nothing, and a different context is a different
 *    question.
 */

import { useEffect, useMemo, useState } from 'react';

import type { AskRouteInfo, AskRouteResponse } from '@/app/api/ask/route';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { askCacheKey } from '@/lib/ai/cache-key';
import {
  entryLookup,
  groundedAskResponseSchema,
  renderPhrase,
  type GroundedAskResponse,
  type RenderedPhrase,
} from '@/lib/ai/ground';
import { cn } from '@/lib/cn';
import type { PhraseToken } from '@/lib/db/schema';
import { getRepository } from '@/lib/db/get-db';
import { fetchEntriesResponse } from '@/lib/dict/client';
import { addCardChecked } from '@/lib/lists/looked-up';
import { getLearnerProfile } from '@/lib/srs/profile';
import { orderGlosses } from '@/lib/srs/presentation';
import { hskBandLabel, type CardContext, type Entry } from '@/lib/types';

/** Long enough that typing a sentence is one ask, short enough to feel answered. */
const DEBOUNCE_MS = 500;

const OFFLINE_BADGE = 'Offline dictionary mode — set ANTHROPIC_API_KEY for AI answers';

type AskState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; response: GroundedAskResponse; entries: Entry[]; dictVersion?: string; cached: boolean }
  | { status: 'error'; message: string };

/**
 * Which provider is live and under which prompt version — two of the five parts
 * of the cache key, so the client has to know them before it can look in the
 * cache. Memoised per page load; it is one small request.
 */
let infoRequest: Promise<AskRouteInfo> | undefined;

const FALLBACK_INFO: AskRouteInfo = { provider: 'fake', promptVersion: 'v1' };

function askInfo(): Promise<AskRouteInfo> {
  infoRequest ??= fetch('/api/ask', { headers: { accept: 'application/json' } })
    .then((res) => (res.ok ? (res.json() as Promise<AskRouteInfo>) : FALLBACK_INFO))
    .catch(() => FALLBACK_INFO);
  return infoRequest;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function citedIds(response: GroundedAskResponse): string[] {
  const ids = new Set<string>();
  for (const match of response.matches) ids.add(match.entryId);
  for (const phrase of response.sayIt) {
    for (const token of phrase.tokens) if (token.entryId) ids.add(token.entryId);
  }
  return [...ids];
}

/** The provenance an Add from this panel writes onto the card (§3.4). */
function askContextFor(query: string, context: CardContext | undefined): CardContext {
  return {
    question: query,
    ...(context?.sentence ? { sentence: context.sentence } : {}),
    ...(context?.offset === undefined ? {} : { offset: context.offset }),
    ...(context?.length === undefined ? {} : { length: context.length }),
    source: 'ask',
    addedAt: Date.now(),
  };
}

type AddState = 'idle' | 'saving' | 'added' | 'existing' | 'error';

function addLabel(state: AddState, added: string, idle: string): string {
  if (state === 'saving') return 'Adding…';
  if (state === 'added' || state === 'existing') return added;
  return idle;
}

// ---------------------------------------------------------------------------

function MatchCard({
  entry,
  senseIndex,
  whyThisOne,
  onAdd,
}: {
  entry: Entry;
  senseIndex: number;
  whyThisOne: string;
  onAdd: (entry: Entry, senseIndex: number) => Promise<'added' | 'existing'>;
}) {
  const [state, setState] = useState<AddState>('idle');
  const glosses = orderGlosses(entry.glosses, senseIndex);

  return (
    <li
      data-testid="ask-match"
      data-entry-id={entry.id}
      data-sense-index={senseIndex}
      className="rounded-lg border border-border px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="hanzi text-lg font-medium">{entry.simp}</span>
        <span className="text-sm text-accent">{entry.pinyinMarked || '—'}</span>
        {entry.hskBand ? <Badge tone="accent">HSK {hskBandLabel(entry.hskBand)}</Badge> : null}
      </div>

      <p data-testid="ask-match-sense" className="mt-1 text-sm">
        {glosses.chosen.join('; ')}
      </p>
      {glosses.others.length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted">
            other senses ({glosses.others.length})
          </summary>
          <ol className="mt-1 list-inside list-decimal text-xs text-muted">
            {glosses.others.map((gloss) => (
              <li key={gloss}>{gloss}</li>
            ))}
          </ol>
        </details>
      ) : null}

      <p data-testid="ask-why" className="mt-2 text-sm text-muted">
        {whyThisOne}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          data-testid="ask-match-add"
          size="sm"
          variant="secondary"
          disabled={state === 'saving' || state === 'added' || state === 'existing'}
          onClick={() => {
            setState('saving');
            onAdd(entry, senseIndex).then(setState, () => setState('error'));
          }}
        >
          {addLabel(state, 'In your cards', 'Add this sense')}
        </Button>
        {state === 'added' ? (
          <span data-testid="ask-match-state" className="text-xs text-accent">
            Added — the card carries your question and shows this sense first.
          </span>
        ) : null}
        {state === 'existing' ? (
          <span data-testid="ask-match-state" className="text-xs text-muted">
            Already in your cards.
          </span>
        ) : null}
        {state === 'error' ? (
          <span data-testid="ask-match-state" className="text-xs text-warning">
            Could not save that card.
          </span>
        ) : null}
      </div>
    </li>
  );
}

function PhraseCard({
  phrase,
  onAddPhrase,
  onAddWords,
}: {
  phrase: RenderedPhrase;
  onAddPhrase: (phrase: RenderedPhrase) => Promise<'added' | 'existing'>;
  onAddWords: (phrase: RenderedPhrase) => Promise<'added' | 'existing'>;
}) {
  const [state, setState] = useState<AddState>('idle');
  const [wordsState, setWordsState] = useState<AddState>('idle');
  const words = phrase.tokens.filter((token) => token.entryId && !token.missing);

  return (
    <li
      data-testid="ask-sayit"
      data-unverified={phrase.unverified ? 'true' : 'false'}
      className="rounded-lg border border-border px-3 py-2"
    >
      <p className="flex flex-wrap items-end gap-x-3 gap-y-1">
        {phrase.tokens.map((token, index) => (
          <span
            key={`${token.entryId ?? token.text}-${index}`}
            data-testid="ask-token"
            data-unverified={token.unverified ? 'true' : 'false'}
            data-ai-generated={token.aiGenerated ? 'true' : 'false'}
            className="flex flex-col items-center"
            title={
              token.aiGenerated
                ? 'AI-generated: no dictionary entry stands behind this token.'
                : token.unverified
                  ? 'Unverified: these characters are not a word this dictionary lists.'
                  : token.polyphone
                    ? 'This character has more than one reading — check the one you want before adding.'
                    : undefined
            }
          >
            <span
              className={cn(
                'hanzi text-2xl',
                (token.unverified || token.aiGenerated) &&
                  'decoration-warning decoration-dotted underline underline-offset-4',
              )}
            >
              {token.text || '?'}
            </span>
            <span className="text-xs text-muted">
              {token.pinyin || (token.aiGenerated ? 'AI' : '—')}
              {token.polyphone ? ' · polyphone' : ''}
            </span>
          </span>
        ))}
      </p>

      <p className="mt-2 text-sm">{phrase.en}</p>
      <p className="text-xs text-muted">{phrase.register}</p>

      {phrase.unverified ? (
        <p data-testid="ask-sayit-warning" className="mt-1 text-xs text-warning">
          Marked tokens are not verified against the dictionary — treat them as a suggestion, not a
          reading.
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          data-testid="ask-sayit-add"
          size="sm"
          variant="secondary"
          disabled={state === 'saving' || state === 'added'}
          onClick={() => {
            setState('saving');
            onAddPhrase(phrase).then(setState, () => setState('error'));
          }}
        >
          {addLabel(state, 'Phrase added', 'Add as a phrase card')}
        </Button>
        {words.length > 0 ? (
          <Button
            data-testid="ask-sayit-add-words"
            size="sm"
            variant="ghost"
            disabled={wordsState === 'saving' || wordsState === 'added' || wordsState === 'existing'}
            onClick={() => {
              setWordsState('saving');
              onAddWords(phrase).then(setWordsState, () => setWordsState('error'));
            }}
          >
            {addLabel(wordsState, 'Words added', `add ${words.length} words individually`)}
          </Button>
        ) : null}
        {state === 'error' || wordsState === 'error' ? (
          <span data-testid="ask-sayit-state" className="text-xs text-warning">
            Could not save that card.
          </span>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------

export interface AskPanelProps {
  /** What to ask about — the typed query, or the headword the panel is showing. */
  query: string;
  /** Where the query came from: a reader tap's sentence, a lookup's query. */
  context?: CardContext;
  className?: string;
}

export function AskPanel({ query, context, className }: AskPanelProps) {
  const [state, setState] = useState<AskState>({ status: 'idle' });
  const [provider, setProvider] = useState<AskRouteInfo['provider']>();

  // The context is an object literal from a store, so it is a new reference on
  // every render. Serialising it makes the effect fire when the provenance
  // actually changes — which is also the thing that changes the cache key.
  const contextJson = context ? JSON.stringify(context) : '';
  const trimmed = query.trim();

  useEffect(() => {
    let cancelled = false;
    askInfo().then((info) => {
      if (!cancelled) setProvider(info.provider);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const run = async (): Promise<void> => {
      setState({ status: 'loading' });
      const askContext = contextJson ? (JSON.parse(contextJson) as CardContext) : undefined;
      try {
        const repo = getRepository();
        const [info, profile] = await Promise.all([askInfo(), getLearnerProfile(repo)]);
        if (cancelled) return;
        setProvider(info.provider);

        const key = await askCacheKey({
          query: trimmed,
          ...(askContext ? { context: askContext } : {}),
          estimatedBand: profile.estimatedBand,
          provider: info.provider,
          promptVersion: info.promptVersion,
        });

        const row = await repo.askCache.get(key).catch(() => undefined);
        const cached = row ? groundedAskResponseSchema.safeParse(row.response) : undefined;
        if (cached?.success) {
          // Ids and indexes are all the cache holds, so the dictionary text is
          // fetched fresh rather than redistributed from IndexedDB.
          const ids = citedIds(cached.data);
          const resolved =
            ids.length > 0
              ? await fetchEntriesResponse(ids, { signal: controller.signal })
              : { meta: { version: '' }, entries: [] };
          if (cancelled) return;
          setState({
            status: 'ready',
            response: cached.data,
            entries: resolved.entries,
            ...(resolved.meta.version ? { dictVersion: resolved.meta.version } : {}),
            cached: true,
          });
          return;
        }

        const res = await fetch('/api/ask', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            query: trimmed,
            ...(askContext ? { context: askContext } : {}),
            profile,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string; hint?: string } | null;
          const message =
            body?.error === 'dict-data-missing'
              ? 'Dictionary data is missing — run pnpm data.'
              : (body?.hint ?? `The ask service answered HTTP ${res.status}.`);
          if (!cancelled) setState({ status: 'error', message });
          return;
        }
        const body = (await res.json()) as AskRouteResponse;
        await repo.askCache.set(key, body.response).catch(() => undefined);
        if (cancelled) return;
        setProvider(body.provider);
        setState({
          status: 'ready',
          response: body.response,
          entries: body.entries,
          ...(body.dictVersion ? { dictVersion: body.dictVersion } : {}),
          cached: false,
        });
      } catch (error) {
        if (cancelled || isAbort(error)) return;
        setState({ status: 'error', message: 'The ask panel could not answer that one.' });
      }
    };

    // Everything, including the reset to idle, happens after the debounce: a
    // setState in the body of an effect is a cascading render (and a lint
    // error), and nothing here needs to be synchronous with the keystroke.
    const timer = setTimeout(() => {
      if (!trimmed) {
        setState({ status: 'idle' });
        return;
      }
      void run();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [trimmed, contextJson]);

  const ready = state.status === 'ready' ? state : undefined;
  const lookup = useMemo(() => entryLookup(ready?.entries ?? []), [ready?.entries]);
  const phrases = useMemo(
    () => (ready ? ready.response.sayIt.map((phrase) => renderPhrase(phrase, lookup)) : []),
    [ready, lookup],
  );

  const addMatch = async (entry: Entry, senseIndex: number): Promise<'added' | 'existing'> => {
    const result = await addCardChecked(
      getRepository(),
      entry,
      askContextFor(trimmed, context),
      senseIndex,
      ready?.dictVersion,
    );
    return result.created ? 'added' : 'existing';
  };

  const addPhrase = async (phrase: RenderedPhrase): Promise<'added' | 'existing'> => {
    const tokens: PhraseToken[] = phrase.tokens
      .filter((token) => token.text.length > 0)
      .map((token) => ({
        text: token.text,
        ...(token.entryId ? { entryId: token.entryId } : {}),
        ...(token.pinyin ? { pinyinMarked: token.pinyin } : {}),
        ...(token.unverified || token.aiGenerated ? { unverified: true } : {}),
      }));
    if (tokens.length === 0) return 'existing';
    await getRepository().addPhraseCard(tokens, phrase.en, askContextFor(trimmed, context));
    return 'added';
  };

  const addWords = async (phrase: RenderedPhrase): Promise<'added' | 'existing'> => {
    let created = false;
    for (const token of phrase.tokens) {
      if (!token.entryId) continue;
      const entry = lookup(token.entryId);
      if (!entry) continue;
      const result = await addCardChecked(
        getRepository(),
        entry,
        askContextFor(trimmed, context),
        undefined,
        ready?.dictVersion,
      );
      created = created || result.created;
    }
    return created ? 'added' : 'existing';
  };

  return (
    <section
      data-testid="ask-panel"
      data-status={state.status}
      data-provider={provider ?? 'unknown'}
      data-cached={ready?.cached ? 'true' : 'false'}
      className={cn('flex flex-col gap-3', className)}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
          Ask — which sense, and what to say
        </h3>
        {provider === 'fake' ? (
          <span data-testid="ask-offline-badge" className="text-xs text-warning">
            {OFFLINE_BADGE}
          </span>
        ) : null}
      </header>

      {state.status === 'idle' ? (
        <p data-testid="ask-status" className="text-sm text-muted">
          Ask in your own words — “how do I say I’m just browsing” — or look a word up and this
          answers which sense the sentence wants.
        </p>
      ) : null}
      {state.status === 'loading' ? (
        <p data-testid="ask-status" className="text-sm text-muted">
          Thinking about “{trimmed}”…
        </p>
      ) : null}
      {state.status === 'error' ? (
        <p data-testid="ask-status" className="text-sm text-warning">
          {state.message} The dictionary result above is unaffected.
        </p>
      ) : null}

      {ready ? (
        <>
          <p data-testid="ask-interpretation" className="text-sm">
            {ready.response.interpretation}
          </p>

          {ready.response.matches.length > 0 ? (
            <ul className="flex flex-col gap-2" data-testid="ask-matches">
              {ready.response.matches.map((match) => {
                const entry = lookup(match.entryId);
                if (!entry) return null;
                return (
                  <MatchCard
                    key={`${match.entryId}-${match.senseIndex}`}
                    entry={entry}
                    senseIndex={match.senseIndex}
                    whyThisOne={match.whyThisOne}
                    onAdd={addMatch}
                  />
                );
              })}
            </ul>
          ) : null}

          {phrases.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold tracking-wide text-muted uppercase">Say it</h4>
              <ul className="flex flex-col gap-2" data-testid="ask-sayits">
                {phrases.map((phrase, index) => (
                  <PhraseCard
                    key={`${phrase.zh}-${index}`}
                    phrase={phrase}
                    onAddPhrase={addPhrase}
                    onAddWords={addWords}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {ready.response.notes.length > 0 ? (
            <ul className="list-inside list-disc text-sm text-muted">
              {ready.response.notes.map((note) => (
                <li key={note} data-testid="ask-note">
                  {note}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
