'use client';

/**
 * The word sheet (docs/plans/core.md C4; product rule 2).
 *
 * Tap a word and it opens with its senses, an Add, a **Mark known** action and
 * — when the tap came from a passage — one line on what the word means *in that
 * sentence*. Tap a character inside it and the character sheet opens on top.
 *
 * **This is `components/reader/reader-lookup.tsx`, folded in.** That file was
 * the only place "Mark known" lived, and C4 moves the action with the surface
 * rather than leaving a second panel behind. Two properties survive verbatim
 * and are the reason the fold is a fold and not a rewrite:
 *
 *  - **it acts on the reading the sheet is SHOWING.** `entryIds` is
 *    frequency-ordered, so the default is the ranked entry — but a learner who
 *    has picked reading B out of a polyphone marks reading B. `EntryDetail`
 *    owns the selection and reports it (`onSelectedChange`).
 *  - **its failure is visible.** A rejected repository write says so, rather
 *    than leaving a button that looks pressed.
 *
 * And one that is read live rather than remembered: whether the word is already
 * known comes from `knownEntryIds()` through `useLiveQuery`, because three
 * writers move those rows — this button, an Add through `EntryDetail`, and the
 * demo seed — and a local `marked` flag disagreed with all of them.
 *
 * **The dictionary arrives as a prop.** `WordSheetSource` is the slice of
 * `DictStore` this component calls, so a `DictStore` satisfies it structurally
 * and C4a swaps the implementation underneath with no edit here. It is never an
 * import of a module-level singleton (core.md C4), because the mobile plans
 * swap it too.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';

import { ContextGloss } from '@/components/hanzi/context-gloss';
import { HanziWord } from '@/components/hanzi/hanzi-text';
import { EntryDetail } from '@/components/lookup/entry-detail';
import { LookupPanel } from '@/components/lookup/lookup-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import type { GroundedMatch } from '@/lib/ai/ground';
import { getRepository } from '@/lib/db/get-db';
import type { DictStore } from '@/lib/dict/store';
import type { SearchGroup } from '@/lib/dict/search';
import type { CardContext, Entry, EntryId, HskBand } from '@/lib/types';

/**
 * Exactly the `DictStore` surface this sheet uses. A `DictStore` satisfies it
 * structurally, so C4a hands over the real store without an edit here.
 *
 * `status` is in it for one reason: **the dictionary version a card is stamped
 * with**. The id path resolves through `entries()`, which returns rows and not
 * a version, where the old fetch carried `meta.version` alongside them — so
 * without this a card added from a reader tap would lose the snapshot it was
 * cut from. `status` carries it when the store is `ready`.
 */
export type WordSheetSource = Pick<DictStore, 'entries' | 'search' | 'status'>;

/** One headword's readings, in the shape `EntryDetail` renders. */
export function groupFromEntries(entries: readonly Entry[]): SearchGroup | undefined {
  if (entries.length === 0) return undefined;
  const [first] = entries;
  const bands = entries
    .map((entry) => entry.hskBand)
    .filter((band): band is HskBand => band !== undefined);
  return {
    key: `${first.trad}|${first.simp}`,
    simp: first.simp,
    trad: first.trad,
    source: 'hanzi',
    matchedIds: entries.map((entry) => entry.id),
    entries: [...entries],
    // The badge shows the easiest way in, as P1's grouping does.
    ...(bands.length > 0 ? { hskBand: Math.min(...bands) as HskBand } : {}),
  };
}

/**
 * The rows, in the order they were asked for.
 *
 * `entryIds` is **frequency-ordered** — that is the whole basis of "Mark known
 * takes the ranked reading" and of which reading `EntryDetail` preselects — and
 * `DictStore.entries(ids)` does not promise to preserve it. Today's HTTP route
 * happens to, so trusting it worked; a store that answered from a set, or a
 * SQL `IN (...)`, would silently hand back a different first reading and mark a
 * polyphone known on one the learner never looked at. Cheap to make true rather
 * than to assume.
 */
function inRequestOrder(entries: readonly Entry[], ids: readonly EntryId[]): Entry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const ordered = ids.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
  // Anything the store returned that was not asked for keeps its place at the
  // end rather than being dropped.
  const seen = new Set(ordered.map((entry) => entry.id));
  return [...ordered, ...entries.filter((entry) => !seen.has(entry.id))];
}

interface Resolved {
  query: string;
  group?: SearchGroup;
  dictVersion?: string;
  error?: string;
}

export interface WordSheetProps {
  open: boolean;
  /**
   * Default true. The reader passes `false`: a reading session is
   * tap-a-word-tap-the-next-word, and a backdrop over the passage makes every
   * word after the first cost two taps. See `components/ui/sheet.tsx`.
   */
  modal?: boolean;
  /** The word as tapped. Also the sheet's accessible name. */
  query: string;
  /**
   * The readings segmentation already resolved, frequency-ordered. Present for
   * a tap on a token; absent for an extended span, which is not a token and has
   * to be asked about by string.
   */
  entryIds?: readonly EntryId[] | undefined;
  /** The sentence the word was met in, when it came from a passage. */
  context?: CardContext | undefined;
  store: WordSheetSource;
  /** The ask module's answer for this word in this sentence (C7 owns its state). */
  gloss?: { match?: GroundedMatch | undefined } | undefined;
  /** Extend the span over the next token; absent when there is nothing to extend to. */
  onExtend?: (() => void) | undefined;
  extendLabel?: string | undefined;
  /**
   * A tap on one character inside the word — the caller opens the character
   * sheet. The **index into the word** travels with it, because the card a
   * character sheet writes needs its own span inside the sentence, not the
   * whole word's.
   */
  onCharacter?: ((char: string, index: number) => void) | undefined;
  onClose: () => void;
}

export function WordSheet({
  open,
  modal,
  query,
  entryIds,
  context,
  store,
  gloss,
  onExtend,
  extendLabel,
  onCharacter,
  onClose,
}: WordSheetProps) {
  const [resolved, setResolved] = useState<Resolved>();
  const [markError, setMarkError] = useState(false);
  const [showing, setShowing] = useState<Entry>();

  /**
   * **Everything about the previous word dies with it.**
   *
   * The sheet is one long-lived instance in the reader — a tap swaps `query`
   * rather than remounting — so anything held in state outlives the word it
   * belongs to unless it is cleared. Two things did, and both were wrong in the
   * same direction: `showing` (the reading `EntryDetail` reports) kept the
   * *previous* word's entry, so between the tap and `store.entries()` resolving
   * — or permanently, for a word with no CC-CEDICT headword — "Mark known" was
   * enabled and wrote the previous word's id; and `markError` left "Could not
   * mark that known." standing under every word tapped after the failure.
   *
   * `resolved` is cleared here too rather than merely being ignored: leaving
   * the old answer in state while `current` filters it out is a trap for the
   * next person who reads `resolved` directly.
   */
  const word = `${query}\u0000${(entryIds ?? []).join(',')}`;
  useEffect(() => {
    setShowing(undefined);
    setMarkError(false);
    setResolved(undefined);
  }, [word]);

  const known = useLiveQuery(async () => new Set(await getRepository().knownEntryIds()), []);

  useEffect(() => {
    if (!open || !query) return;
    let cancelled = false;

    void (async () => {
      try {
        if (entryIds && entryIds.length > 0) {
          // Resolved by id, not re-searched: segmentation already decided which
          // headword this is in context, and asking by string would hand that
          // decision back to a ranker that cannot see the sentence.
          const entries = await store.entries(entryIds);
          if (cancelled) return;
          const version = store.status.state === 'ready' ? store.status.version : undefined;
          setResolved({
            query,
            group: groupFromEntries(inRequestOrder(entries, entryIds)),
            ...(version === undefined ? {} : { dictVersion: version }),
          });
          return;
        }
        const result = await store.search(query);
        if (cancelled) return;
        setResolved({ query, group: result.groups[0], dictVersion: result.dictVersion });
      } catch {
        if (cancelled) return;
        setResolved({ query, error: 'Could not reach the dictionary.' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, query, entryIds, store]);

  // Gated on the answer being for *this* query, so a stale one never renders.
  const current = resolved?.query === query ? resolved : undefined;
  const group = current?.group;
  /**
   * The entry "Mark known" acts on: the reading the sheet is **showing**,
   * defaulting to the ranked one.
   *
   * `showing` is only honoured when it is still one of the resolved group's
   * entries. The effect above clears it on a word change, but an effect runs
   * after paint — and more importantly a *derived* guard cannot be defeated by
   * a render order: while the new word is resolving, or for ever when it has no
   * CC-CEDICT headword, `group` is undefined and `marking` is undefined with
   * it, so the button is disabled exactly as the deleted `reader-lookup.tsx`
   * left it (`primary = group?.entries[0]`). Without this the sheet showed one
   * word and marked another.
   */
  const marking =
    showing && group?.entries.some((entry) => entry.id === showing.id)
      ? showing
      : group?.entries[0];
  const alreadyKnown = marking !== undefined && (known?.has(marking.id) ?? false);

  const markKnown = async () => {
    if (!marking) return;
    setMarkError(false);
    try {
      await getRepository().markKnown([marking.id]);
    } catch {
      setMarkError(true);
    }
  };

  const onSelectedChange = useCallback((entry: Entry) => setShowing(entry), []);

  const characters = [...query];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      {...(modal === undefined ? {} : { modal })}
      title={query || 'Look up'}
      // The sheet's own heading would be a second copy of `LookupPanel`'s
      // `<h2>`; the name it gives the dialog is what matters here.
      hideTitle
      data-testid="word-sheet"
    >
      {/*
        `LookupPanel` comes with it. It is what renders the query as the learner
        met it, the provenance sentence and the "from reader" badge — the three
        things `tests/e2e/p5` asserts a tap carries — and dropping it in the
        fold would have quietly thrown away the provenance the whole mining loop
        is built on. `reader-panel` is kept as a test id for the same reason:
        the surface is the same one, re-homed, and renaming the reader's
        contract is not this phase's to do.
      */}
      <div data-testid="reader-panel">
        <LookupPanel query={query} {...(context === undefined ? {} : { context })} noAsk>
        {current?.error ? (
          <p className="text-sm text-warning">{current.error}</p>
        ) : group ? (
          <EntryDetail
            key={group.key}
            group={group}
            query={query}
            {...(context === undefined ? {} : { context })}
            {...(current?.dictVersion === undefined ? {} : { dictVersion: current.dictVersion })}
            onSelectedChange={onSelectedChange}
            belowHeadword={
              // Only from a passage. A lookup from the search box has no
              // sentence, so there is nothing to disambiguate against and the
              // line would be the model guessing at a context it was not given.
              context?.sentence ? (
                <ContextGloss
                  entry={marking}
                  {...(gloss?.match === undefined ? {} : { match: gloss.match })}
                />
              ) : null
            }
          />
        ) : current ? (
          <p className="text-sm text-muted">
            The dictionary has no headword for “{query}”. It is still a word — it is just not one
            CC-CEDICT lists.
          </p>
        ) : (
          <p className="text-sm text-muted">Looking it up…</p>
        )}

        {onCharacter && characters.length > 0 ? (
          <div className="mt-4 border-t border-border pt-3">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
              Characters
            </h3>
            <div className="mt-2 flex flex-wrap gap-2" data-testid="word-sheet-characters">
              {characters.map((char, index) => (
                <Button
                  key={`${char}-${index}`}
                  data-testid="open-character"
                  data-char={char}
                  variant="secondary"
                  size="sm"
                  onClick={() => onCharacter(char, index)}
                >
                  <HanziWord text={char} className="text-lg" />
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <Button
            data-testid="mark-known"
            variant="secondary"
            size="sm"
            onClick={markKnown}
            disabled={!marking || alreadyKnown}
          >
            {alreadyKnown ? 'Marked known' : 'Mark known'}
          </Button>
          {onExtend ? (
            <Button data-testid="extend-span" variant="secondary" size="sm" onClick={onExtend}>
              {extendLabel ?? 'Extend'}
            </Button>
          ) : null}
          <Button data-testid="close-panel" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          {alreadyKnown ? (
            <Badge tone="accent">
              {/* C3's call-site table assigns this run to C4 ("folded into the
                  word sheet by C4; switched there, not here"). It is the same
                  headword `EntryDetail` renders two lines above, and it was the
                  one Chinese run in the sheet with no ruby. */}
              <HanziWord
                text={marking?.simp ?? ''}
                {...(marking?.pinyinNum === undefined ? {} : { pinyinNum: marking.pinyinNum })}
              />
              <span className="ml-1">is known</span>
            </Badge>
          ) : null}
          {markError ? (
            <span className="text-sm text-warning">Could not mark that known.</span>
          ) : null}
        </div>

        {group && group.entries.length > 1 && !alreadyKnown ? (
            <p className="mt-2 text-xs text-muted">
              “Mark known” takes the reading shown ({marking?.pinyinMarked}); the other readings
              keep their own colour.
            </p>
          ) : null}
        </LookupPanel>
      </div>
    </Sheet>
  );
}
