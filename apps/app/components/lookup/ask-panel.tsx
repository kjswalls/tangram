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
 *    come from entries this device's own dictionary resolved, through
 *    `renderPhrase`. The model's own strings are visibly marked, and so is
 *    anything grounding could not verify.
 *  - **It checks the cache before it asks.** A repeat question with the same
 *    context costs nothing, and a different context is a different question.
 *
 * **What this file is, after `backend.md` B2's contract flip.** All three
 * properties above are now facts about `lib/ai/ask-client.ts` — retrieval,
 * the two round trips, `ground()`, the empty-answer fallback and the cache are
 * its — and this file is the rendering. B2 changed the module and this call
 * site and **no state of the panel**: the five states, their copy and their
 * test ids are `core.md` C7's and are untouched.
 */

import { useEffect, useMemo, useState } from 'react';

import type { ProviderName } from '@tangram/ai/schemas';
import { HanziWord } from '@/components/hanzi/hanzi-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { EmptyState } from '@/components/ui/empty-state';
import {
  ASK_NOT_CONFIGURED_BODY,
  ASK_NOT_CONFIGURED_CHIP,
  ASK_OFFLINE_CHIP,
  ASK_RETRY_LABEL,
  ASK_UNREACHABLE_BODY,
  ASK_UNGROUNDED_BODY,
  ASK_UNGROUNDED_TITLE,
  type AskStateName,
  type AskUnavailableReason,
} from '@/components/lookup/ask-state';
import {
  entryLookup,
  renderPhrase,
  type PhraseScript,
  type GroundedAskResponse,
  type RenderedPhrase,
} from '@tangram/ai/ground';
/**
 * **The ask module (`backend.md` B2).** Retrieval, the two round trips,
 * `ground()`, the empty-answer fallback and the cache all live in
 * `lib/ai/ask-client.ts` now — this panel asks it a question and renders what
 * comes back. B2 changes the module and this call site, and **no state of the
 * panel**: `core.md` C7 owns `thinking`, `unavailable` and `ungrounded`, and
 * every one of them is drawn exactly as it was before the flip.
 */
import { FALLBACK_INFO, ask, askInfo, isAbort } from '@/lib/ai/ask-client';
import { API_CONFIGURED } from '@/src/access/client';
import { cn } from '@/lib/cn';
import type { PhraseToken } from '@/lib/db/schema';
import { getRepository } from '@/lib/db/get-db';
import {
  addCardChecked,
  addPhraseCardChecked,
  phraseCardFor,
} from '@/lib/lists/looked-up';
import { orderGlosses } from '@/lib/srs/presentation';

import { hskBandLabel, type CardContext, type Entry } from '@/lib/types';

/** Long enough that typing a sentence is one ask, short enough to feel answered. */
const DEBOUNCE_MS = 500;

const OFFLINE_BADGE =
  'Offline dictionary mode — set ANTHROPIC_API_KEY for AI answers';

/**
 * Longer than the route's own answer deadline (30 s), so a slow provider
 * normally comes back as the route's 502 with a reason. This one is the
 * backstop for the network itself: nothing else on the page would ever take
 * "Thinking about …" off the screen.
 */
const ASK_TIMEOUT_MS = 35_000;

type AskState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready';
      response: GroundedAskResponse;
      entries: Entry[];
      dictVersion?: string;
      cached: boolean;
      /**
       * What this answer answers. The panel keeps rendering the previous
       * answer for the debounce after the question changes, so without this the
       * learner reads one word's answer under another word's heading — and an
       * Add pressed in that window writes a card whose provenance names a word
       * that is not on it.
       */
      answered: { query: string; contextJson: string };
    }
  | { status: 'error'; message: string; reason: AskUnavailableReason };

/**
 * The panel's own four internal statuses, mapped onto the five the rest of the
 * app names (`ask-state.ts`, core.md C7).
 *
 * The two vocabularies are deliberately not merged. `status` is *what the fetch
 * is doing* and several specs assert it; `AskStateName` is **what the learner is
 * being told**, and it is the one C7's three fixtures and C1's gallery agree
 * on. The interesting half is that one internal status splits in two: a `ready`
 * answer with nothing left after grounding is `ungrounded`, not `answered`, and
 * that distinction is the visible face of PLAN.md §3.4.
 *
 * `stale` folds into `thinking` because a debounce showing the previous word's
 * answer is, to the learner, the next word's answer not being ready yet.
 */
export function askUiState(input: {
  readonly status: AskState['status'];
  /** The rendered answer belongs to a previous question. */
  readonly stale?: boolean;
  /** `ready` only: something survived grounding and is on screen. */
  readonly grounded?: boolean;
}): AskStateName {
  if (input.stale) return 'thinking';
  switch (input.status) {
    case 'idle':
      return 'idle';
    case 'loading':
      return 'thinking';
    case 'error':
      return 'unavailable';
    case 'ready':
      return input.grounded ? 'answered' : 'ungrounded';
  }
}

/**
 * Re-exported rather than redefined. Both moved into `lib/ai/ask-client.ts`
 * with the rest of the fetch — they are facts about *reachability*, and after
 * `backend.md` B2 the module that does the reaching is the ask client. The
 * spelling stays here because `tests/unit/lookup/ask-state.test.ts` is
 * `core.md` C7's file and imports them from this one.
 */
export { statusReason, unavailableReason } from '@/lib/ai/ask-client';

/**
 * The provenance an Add from this panel writes onto the card (§3.4).
 *
 * Both halves travel: the question the learner asked, and — when the ask came
 * from a reader tap — the sentence it was asked about. That pairing is the
 * whole point of the ask panel living inside the reader.
 *
 * The `offset`/`length` span is the one thing that does **not** travel by
 * default. It points at the token that was tapped, and the card back highlights
 * `sentence.slice(offset, offset + length)` in preference to searching for the
 * headword (`lib/srs/context.ts`). An ask answers with words the tap did not
 * name — a second sense, a whole phrase — so carrying the tap's span onto them
 * would underline the wrong characters with total confidence. The span is kept
 * only when the sentence actually reads as the word being added at that
 * position; otherwise it is dropped and `resolveContext` locates the headword
 * itself, which is right or visibly absent, never quietly wrong.
 */
function askContextFor(
  query: string,
  context: CardContext | undefined,
  targets: readonly string[] = [],
): CardContext {
  const { sentence, offset, length } = context ?? {};
  const spanReads =
    sentence !== undefined &&
    offset !== undefined &&
    length !== undefined &&
    targets.some(
      (target) =>
        target.length > 0 && sentence.slice(offset, offset + length) === target,
    );

  // "From the question: 看" is not a question — it is the word itself, and a
  // card back that quotes its own headword as provenance says nothing while
  // offering a "Peek context" that reveals ＿. A bare-headword ask carries no
  // question; `resolveContext` then finds nothing to show, which is honest.
  const isHeadword = targets.some(
    (target) => target.length > 0 && target === query.trim(),
  );

  return {
    ...(isHeadword ? {} : { question: query }),
    ...(sentence ? { sentence } : {}),
    ...(spanReads ? { offset, length } : {}),
    source: 'ask',
    addedAt: Date.now(),
  };
}

/** The forms a card's headword can appear in inside a mined sentence. */
function headwordForms(entry: Entry): string[] {
  return entry.simp === entry.trad ? [entry.simp] : [entry.simp, entry.trad];
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
        <HanziWord
          text={entry.simp}
          pinyinNum={entry.pinyinNum}
          className="text-lg font-medium"
        />
        <span className="text-sm text-accent">{entry.pinyinMarked || '—'}</span>
        {entry.hskBand ? (
          <Badge tone="accent">HSK {hskBandLabel(entry.hskBand)}</Badge>
        ) : null}
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
          disabled={
            state === 'saving' || state === 'added' || state === 'existing'
          }
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

/** What an "add the words individually" run actually did, for the line under it. */
export interface WordsAdded {
  added: number;
  existing: number;
  /** Words the learner already knows, which a review card would only get in the way of. */
  known: string[];
}

function wordsMessage(result: WordsAdded): string {
  const parts: string[] = [];
  if (result.added > 0) parts.push(`${result.added} added`);
  if (result.existing > 0)
    parts.push(`${result.existing} already in your cards`);
  if (result.known.length > 0)
    parts.push(`${result.known.join(' · ')} already known`);
  return parts.length > 0 ? parts.join(' · ') : 'Nothing to add.';
}

function PhraseCard({
  phrase,
  stored,
  onAddPhrase,
  onAddWords,
  onProbe,
}: {
  /** The phrase as the learner reads it — in their script preference. */
  phrase: RenderedPhrase;
  /**
   * The same phrase rendered simplified, which is what a card *stores*. A
   * phrase card keeps its tokens (`PhraseFace` draws them one at a time), and a
   * snapshot is never re-resolved (§3.3), so writing the display script into it
   * would make a preference that can be changed a permanent property of a card.
   * The reading and the ids are identical between the two.
   */
  stored: RenderedPhrase;
  onAddPhrase: (phrase: RenderedPhrase) => Promise<'added' | 'existing'>;
  onAddWords: (phrase: RenderedPhrase) => Promise<WordsAdded>;
  onProbe: (phrase: RenderedPhrase) => Promise<boolean>;
}) {
  const [state, setState] = useState<AddState>('idle');
  const [wordsState, setWordsState] = useState<AddState>('idle');
  const [wordsResult, setWordsResult] = useState<WordsAdded>();
  const words = phrase.tokens.filter(
    (token) => token.entryId && !token.missing,
  );

  /**
   * A phrase card the learner already has. `addPhraseCardChecked` is idempotent,
   * but the button has to say so *before* it is pressed — otherwise the same
   * question asked twice reads as two different phrases worth adding.
   */
  useEffect(() => {
    let cancelled = false;
    onProbe(stored).then(
      (existing) => {
        if (!cancelled && existing) setState('existing');
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // The probe is about the phrase this card draws; `onProbe` is a new closure
    // every render, so keying on it would re-probe forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phrase.zh]);

  /**
   * A phrase is only addable when every character on its front came from the
   * dictionary. A `{text}` token puts the model's own hanzi on a 6xl card face
   * with no flag on it (the review card renders `snapshot.simp`, not the
   * tokens) and its pinyin line silently skips the syllable — a learner
   * memorising an invented word with a reading that does not match it is the
   * exact failure §1 commitment 3 exists to prevent.
   */
  const blocked = phrase.unverified;

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
            {/*
              The reading is ABOVE the token now (core.md C3), through the same
              `<HanziText>` every other Chinese run goes through, and `force`
              because the ask panel is answering a question: it prints the
              reading whatever `pinyinDisplay` says.

              **Token-granular, not character-granular**, and that is a
              frozen-surface limit rather than a choice — `RenderedToken`
              (lib/ai/ground.ts) carries `pinyin` as the MARKED word-level form
              and `alignReading` needs the NUMBERED one, so the run aligns in
              `fallback` mode: one correct word-level annotation rather than a
              guessed per-character one. Recorded in HANDOFF.md.
            */}
            <HanziWord
              text={token.text || '?'}
              {...(token.pinyin ? { pinyinMarked: token.pinyin } : {})}
              force
              className={cn(
                'text-2xl',
                (token.unverified || token.aiGenerated) &&
                  'decoration-warning decoration-dotted underline underline-offset-4',
              )}
            />
            {/*
              A token the model invented has no reading to put above it, and
              the flag is the whole point of the row — so it keeps its own line
              rather than vanishing with the pinyin.
            */}
            {token.pinyin ? null : (
              <span className="text-xs text-warning">
                {token.aiGenerated ? 'AI' : '—'}
              </span>
            )}
            {token.polyphone ? (
              <span className="text-xs text-muted">polyphone</span>
            ) : null}
          </span>
        ))}
      </p>

      <p className="mt-2 text-sm">{phrase.en}</p>
      <p className="text-xs text-muted">{phrase.register}</p>

      {phrase.unverified ? (
        <p
          data-testid="ask-sayit-warning"
          className="mt-1 text-xs text-warning"
        >
          Marked tokens are not verified against the dictionary — treat them as
          a suggestion, not a reading.{' '}
          {words.length > 0
            ? `This phrase cannot become a card, because its front would show characters no dictionary row stands behind; the ${words.length} cited ${words.length === 1 ? 'word' : 'words'} can.`
            : 'This phrase cannot become a card.'}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          data-testid="ask-sayit-add"
          size="sm"
          variant="secondary"
          disabled={
            blocked ||
            state === 'saving' ||
            state === 'added' ||
            state === 'existing'
          }
          title={
            blocked
              ? 'This phrase contains characters the dictionary could not verify.'
              : undefined
          }
          onClick={() => {
            setState('saving');
            onAddPhrase(stored).then(setState, () => setState('error'));
          }}
        >
          {blocked
            ? 'Not verified — cannot add'
            : addLabel(
                state,
                state === 'existing' ? 'Already in your cards' : 'Phrase added',
                'Add as a phrase card',
              )}
        </Button>
        {words.length > 0 ? (
          <Button
            data-testid="ask-sayit-add-words"
            size="sm"
            variant="ghost"
            disabled={wordsState === 'saving' || wordsState === 'added'}
            onClick={() => {
              setWordsState('saving');
              onAddWords(stored).then(
                (result) => {
                  setWordsResult(result);
                  setWordsState('added');
                },
                () => setWordsState('error'),
              );
            }}
          >
            {addLabel(
              wordsState,
              'Words added',
              `add ${words.length} words individually`,
            )}
          </Button>
        ) : null}
        {wordsState === 'added' && wordsResult ? (
          <span
            data-testid="ask-sayit-words-state"
            className="text-xs text-muted"
          >
            {wordsMessage(wordsResult)}
          </span>
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
  /**
   * Whether this build has an API (`API_CONFIGURED`). A prop only so the
   * gallery and the unit tests can draw the not-configured state without a
   * second build; the app never passes it.
   */
  configured?: boolean;
}

/**
 * The two reasons that mean "a base is set and nothing answered" — the pair
 * that gets a retry. Every other `unavailable` reason is a server that did
 * answer, and keeps the quiet line it always had.
 */
export function isUnreachable(reason: AskUnavailableReason): boolean {
  return reason === 'offline' || reason === 'timeout';
}

export function AskPanel({ query, context, className, configured = API_CONFIGURED }: AskPanelProps) {
  const [state, setState] = useState<AskState>({ status: 'idle' });
  /** Bumped by the unreachable state's retry, which re-runs the ask effect. */
  const [attempt, setAttempt] = useState(0);
  const [provider, setProvider] = useState<ProviderName>();
  // The learner's script, read once. Display only: ids, readings and everything
  // a card stores are the same row either way.
  const [script, setScript] = useState<PhraseScript>('simp');

  // The context is an object literal from a store, so it is a new reference on
  // every render. Serialising it makes the effect fire when the provenance
  // actually changes — which is also the thing that changes the cache key.
  const contextJson = context ? JSON.stringify(context) : '';
  const trimmed = query.trim();

  useEffect(() => {
    let cancelled = false;
    // No API, no handshake: the not-configured state needs no provider, and a
    // build with no base must not send anything anywhere.
    //
    // A *failed* handshake sets nothing either. `askInfo` answers a failure
    // with `FALLBACK_INFO` — provider `fake` — and painting that as the
    // provider put "set ANTHROPIC_API_KEY" over a server that was simply down.
    if (configured) {
      askInfo().then((info) => {
        if (!cancelled && info !== FALLBACK_INFO) setProvider(info.provider);
      });
    }
    getRepository()
      .getSettings()
      .then(
        (settings) => {
          if (!cancelled) setScript(settings.script);
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
    };
  }, [configured]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // Nothing else ever ends the wait: the panel's own abort fires on unmount
    // and on a new question, and the provider call has no deadline of its own
    // that the browser can see.
    const deadline = setTimeout(
      () => controller.abort(new DOMException('timeout', 'TimeoutError')),
      ASK_TIMEOUT_MS,
    );

    const answered = { query: trimmed, contextJson };

    const run = async (): Promise<void> => {
      setState({ status: 'loading' });
      const askContext = contextJson
        ? (JSON.parse(contextJson) as CardContext)
        : undefined;
      try {
        // The handshake first, and on its own: the offline badge is a fact
        // about the provider, and it should be right while the answer is still
        // being thought about rather than only once it arrives.
        const info = await askInfo();
        if (cancelled) return;
        if (info !== FALLBACK_INFO) setProvider(info.provider);

        const outcome = await ask(
          { query: trimmed, ...(askContext ? { context: askContext } : {}) },
          { signal: controller.signal },
        );
        if (cancelled) return;

        if (outcome.state === 'unavailable') {
          setState({
            status: 'error',
            message: outcome.message,
            reason: outcome.reason,
          });
          return;
        }

        setProvider(outcome.provider);
        setState({
          status: 'ready',
          response: outcome.response,
          entries: outcome.entries,
          ...(outcome.dictVersion ? { dictVersion: outcome.dictVersion } : {}),
          cached: outcome.cached,
          answered,
        });
      } catch (error) {
        // `ask()` turns every ordinary failure into `unavailable` and rethrows
        // only the caller's own abort — a new keystroke or an unmount — which
        // is not a state worth rendering.
        if (cancelled || isAbort(error)) return;
        setState({
          status: 'error',
          message: 'The ask panel could not answer that one.',
          reason: 'server',
        });
      }
    };

    // Everything, including the reset to idle, happens after the debounce: a
    // setState in the body of an effect is a cascading render (and a lint
    // error), and nothing here needs to be synchronous with the keystroke.
    // Nothing to ask with. The not-configured state is drawn from the prop
    // alone, so there is no status to set and no request to make.
    if (!configured) {
      clearTimeout(deadline);
      return;
    }

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
      clearTimeout(deadline);
    };
  }, [trimmed, contextJson, configured, attempt]);

  // The answer on screen answers the *previous* question for as long as the
  // debounce runs. Deriving staleness in render (rather than resetting the
  // state in an effect) keeps this a pure read of what is already known.
  const answer = state.status === 'ready' ? state : undefined;
  const stale =
    answer !== undefined &&
    (answer.answered.query !== trimmed ||
      answer.answered.contextJson !== contextJson);
  const ready = stale ? undefined : answer;
  const thinking = state.status === 'loading' || stale;

  const lookup = useMemo(
    () => entryLookup(ready?.entries ?? []),
    [ready?.entries],
  );
  const phrases = useMemo(
    () =>
      ready
        ? ready.response.sayIt.map((phrase) =>
            renderPhrase(phrase, lookup, script),
          )
        : [],
    [ready, lookup, script],
  );
  // What a card would keep, which is always simplified — see `PhraseCard`.
  const storedPhrases = useMemo(
    () =>
      ready && script !== 'simp'
        ? ready.response.sayIt.map((phrase) => renderPhrase(phrase, lookup))
        : phrases,
    [ready, lookup, script, phrases],
  );
  /**
   * The matches that will actually render.
   *
   * A cited id that is not in the resolved entries renders **nothing** — the
   * map below returns `null` for it, which is PLAN.md §3.4 working — but
   * `response.matches.length` still counted it. An answer whose every proposal
   * failed grounding therefore reported itself as `answered` and drew a heading
   * over an empty section, which is the one outcome §3.4 forbids and precisely
   * what the `ungrounded` state exists to say instead. Derived once here and
   * used for both the decision and the rendering, so the two cannot disagree.
   */
  const matches = useMemo(
    () =>
      ready
        ? ready.response.matches.filter(
            (match) => lookup(match.entryId) !== undefined,
          )
        : [],
    [ready, lookup],
  );

  const empty =
    ready !== undefined &&
    ready.response.interpretation.length === 0 &&
    matches.length === 0 &&
    phrases.length === 0;

  /**
   * What the learner is being told, in the five names the rest of the app uses
   * (`ask-state.ts`). `data-ask-state` below is what C7's three fixtures read,
   * and it is deliberately a second attribute rather than a rename of
   * `data-status`: the specs that assert `data-status` are asserting what the
   * fetch is doing, which is a different and still-useful fact.
   */
  const uiState: AskStateName = configured
    ? askUiState({ status: state.status, stale, grounded: !empty })
    : 'unavailable';

  /**
   * Which of the two "no API" situations this is, if either — the attribute the
   * no-API specs read, and the switch for which of the two blocks below draws.
   */
  const apiProblem = !configured
    ? 'not-configured'
    : state.status === 'error' && isUnreachable(state.reason)
      ? 'unreachable'
      : undefined;

  const addMatch = async (
    entry: Entry,
    senseIndex: number,
  ): Promise<'added' | 'existing'> => {
    // Snapshot the provenance the moment the button is pressed: an answer that
    // lands mid-click must not pair this entry with the next question's words.
    const provenance = askContextFor(trimmed, context, headwordForms(entry));
    const result = await addCardChecked(
      getRepository(),
      entry,
      provenance,
      senseIndex,
      ready?.dictVersion,
    );
    return result.created ? 'added' : 'existing';
  };

  /** Tokens of a phrase as the card layer stores them. */
  const phraseTokens = (phrase: RenderedPhrase): PhraseToken[] =>
    phrase.tokens
      .filter((token) => token.text.length > 0)
      .map((token) => ({
        text: token.text,
        ...(token.entryId ? { entryId: token.entryId } : {}),
        ...(token.pinyin ? { pinyinMarked: token.pinyin } : {}),
        ...(token.unverified || token.aiGenerated ? { unverified: true } : {}),
      }));

  const probePhrase = async (phrase: RenderedPhrase): Promise<boolean> =>
    (await phraseCardFor(getRepository(), phraseTokens(phrase))) !== undefined;

  const addPhrase = async (
    phrase: RenderedPhrase,
  ): Promise<'added' | 'existing'> => {
    const tokens = phraseTokens(phrase);
    if (tokens.length === 0) return 'existing';
    // A phrase is never the tapped token, so it never inherits the tap's span.
    const result = await addPhraseCardChecked(
      getRepository(),
      tokens,
      phrase.en,
      askContextFor(trimmed, context),
      // The same snapshot the cited entries were resolved from: a phrase card
      // records the dictionary behind it exactly as a word card does.
      ready?.dictVersion,
    );
    return result.created ? 'added' : 'existing';
  };

  /**
   * The cited words, one card each — minus the ones the learner already knows.
   * "Add 3 words" that queues 我 for review today, over a word `known_words`
   * says is known and the reader paints as known, is the app arguing with a
   * decision the learner already made.
   */
  const addWords = async (phrase: RenderedPhrase): Promise<WordsAdded> => {
    const repo = getRepository();
    const [known, settings] = await Promise.all([
      repo.knownEntryIds(),
      repo.getSettings(),
    ]);
    const knownIds = new Set(known);
    const result: WordsAdded = { added: 0, existing: 0, known: [] };

    for (const token of phrase.tokens) {
      if (!token.entryId) continue;
      const entry = lookup(token.entryId);
      if (!entry) continue;
      if (
        knownIds.has(entry.id) ||
        (entry.hskBand !== undefined && entry.hskBand <= settings.knownBand)
      ) {
        result.known.push(entry.simp);
        continue;
      }
      // A word that is also one of the answer's matches is added at *that*
      // sense: cards are keyed on (entryId, senseIndex), so a sense-less add
      // beside a sense-specific one is the same word twice.
      const match = ready?.response.matches.find(
        (candidate) => candidate.entryId === entry.id,
      );
      const added = await addCardChecked(
        repo,
        entry,
        askContextFor(trimmed, context, headwordForms(entry)),
        match?.senseIndex,
        ready?.dictVersion,
      );
      if (added.created) result.added += 1;
      else result.existing += 1;
    }
    return result;
  };

  return (
    <section
      data-testid="ask-panel"
      data-status={stale ? 'loading' : state.status}
      data-ask-state={uiState}
      data-provider={provider ?? 'unknown'}
      data-cached={ready?.cached ? 'true' : 'false'}
      data-api={apiProblem ?? 'ok'}
      className={cn('flex flex-col gap-3', className)}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
          Ask — which sense, and what to say
        </h3>
        {provider === 'fake' ? (
          <span
            data-testid="ask-offline-badge"
            className="text-xs text-warning"
          >
            {OFFLINE_BADGE}
          </span>
        ) : null}
      </header>

      {/*
        **The three states are announced, not only drawn** (C8's review).
        `thinking`, `unavailable` and `ungrounded` swap in asynchronously with
        no focus move, so without a live region a screen-reader learner is never
        told that no AI was reachable or that grounding rejected everything —
        the two states product-decisions §5 calls the visible face of the
        grounding promise. `polite` because none of them interrupts anything,
        and it wraps all of them so the region is present before the first
        change (an `aria-live` element inserted *with* its content is often not
        announced at all).
      */}
      <div role="status" aria-live="polite" className="contents">
        {/*
          **No API in this build.** Drawn from the first paint, whatever the
          query, and instead of the idle invitation — "ask in your own words"
          over a panel that can never answer is the dead control this state
          exists to replace. No retry: nothing the learner does changes a
          build-time fact.
        */}
        {apiProblem === 'not-configured' ? (
          <div className="flex flex-col items-start gap-1">
            <Chip tone="neutral" data-testid="ask-not-configured-chip">
              {ASK_NOT_CONFIGURED_CHIP}
            </Chip>
            <p data-testid="ask-status" className="text-sm text-muted">
              {ASK_NOT_CONFIGURED_BODY}
            </p>
          </div>
        ) : null}
        {configured && state.status === 'idle' ? (
          <p data-testid="ask-status" className="text-sm text-muted">
            Ask in your own words — “how do I say I’m just browsing” — or look a
            word up and this answers which sense the sentence wants.
          </p>
        ) : null}
        {thinking ? (
          <div className="flex flex-col items-start gap-1">
            <Chip tone="lookup" data-testid="ask-ai-chip">
              AI
            </Chip>
            <p data-testid="ask-status" className="text-sm text-muted">
              Thinking about “{trimmed}”…
            </p>
          </div>
        ) : null}
        {apiProblem === 'unreachable' ? (
          <div className="flex flex-col items-start gap-2">
            {/*
              A base is set and nothing answered. The same chip as any other
              `unavailable` — the dictionary really is all there is right now —
              with the one thing the other reasons do not get: a retry, because
              this is the one that can fix itself.
            */}
            <Chip tone="neutral" data-testid="ask-offline-chip">
              {ASK_OFFLINE_CHIP}
            </Chip>
            <p data-testid="ask-status" className="text-sm text-muted">
              {ASK_UNREACHABLE_BODY} The dictionary result above is unaffected.
            </p>
            <Button
              data-testid="ask-retry"
              variant="secondary"
              size="sm"
              onClick={() => setAttempt((count) => count + 1)}
            >
              {ASK_RETRY_LABEL}
            </Button>
          </div>
        ) : null}
        {configured && apiProblem === undefined && uiState === 'unavailable' && state.status === 'error' ? (
          <div className="flex flex-col items-start gap-1">
            {/*
            The whole visible face of "no AI is reachable" (product-decisions
            §5): one quiet chip, and everything else on the page still works.
            The reason lives on the state, not on the chip.
          */}
            <Chip tone="neutral" data-testid="ask-offline-chip">
              {ASK_OFFLINE_CHIP}
            </Chip>
            <p data-testid="ask-status" className="text-sm text-muted">
              {state.message} The dictionary result above is unaffected.
            </p>
          </div>
        ) : null}
        {/*
          **Inside the region, not beside it.** This was rendered in the sibling
          subtree below, so the comment above named three states and the region
          carried two: a screen-reader learner was told the app had stopped
          thinking and never told why. `ungrounded` is the one state of the
          three that PLAN.md §3.4's grounding promise exists to make visible,
          so it is the one that least belongs outside. Found by C8's adversarial
          review; `tests/e2e/core/ask-states.spec.ts` now asserts the ancestry
          rather than the text alone.

          An `EmptyState`, not an empty answer body (product-decisions §5).
          Saying "nothing could be checked" out loud is the difference between
          grounding having rejected every proposal and the model having said
          nothing — and the words the rejected phrases were made of are still
          addable from the dictionary card above, which is why this replaces
          only the answer.
        */}
        {ready && empty ? (
          <EmptyState data-testid="ask-ungrounded" title={ASK_UNGROUNDED_TITLE}>
            {ASK_UNGROUNDED_BODY}
          </EmptyState>
        ) : null}
      </div>

      {ready ? (
        <>
          {empty ? null : (
            <>
              <Chip tone="lookup" data-testid="ask-ai-chip">
                AI
              </Chip>
              <p data-testid="ask-interpretation" className="text-sm">
                {ready.response.interpretation}
              </p>
            </>
          )}

          {matches.length > 0 ? (
            <ul className="flex flex-col gap-2" data-testid="ask-matches">
              {matches.map((match) => {
                const entry = lookup(match.entryId)!;
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
              <h4 className="text-xs font-semibold tracking-wide text-muted uppercase">
                Say it
              </h4>
              <ul className="flex flex-col gap-2" data-testid="ask-sayits">
                {phrases.map((phrase, index) => (
                  <PhraseCard
                    key={`${phrase.zh}-${index}`}
                    phrase={phrase}
                    stored={storedPhrases[index]}
                    onAddPhrase={addPhrase}
                    onAddWords={addWords}
                    onProbe={probePhrase}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {ready.response.notes.length > 0 ? (
            <ul className="list-inside list-disc text-sm text-muted">
              {ready.response.notes.map((note, index) => (
                <li key={`${index}-${note}`} data-testid="ask-note">
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
