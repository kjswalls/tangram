'use client';

/**
 * The body of the lookup panel: one headword, all of its readings, and the Add
 * that turns it into a card.
 *
 * The reading choice is the point. A polyphone reaches the panel as one result
 * carrying every reading, so Add cannot silently pick one — 了 is `le` or `liǎo`
 * and a card for the wrong one teaches the wrong word. The first reading (the most
 * frequent) is preselected, its pinyin is shown, and the card is written for
 * whichever is selected when Add is pressed.
 *
 * Decomposition comes from its own route because it comes from its own file under
 * its own licence (CLAUDE.md); it is displayed and never written onto the card.
 */
import { useScreenNavigate } from '@/components/screens/navigate';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { SpeakButton } from '@/components/tts/speak-button';
import { HanziWord } from '@/components/hanzi/hanzi-text';
import { alignReading } from '@/lib/hanzi/align';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { getRepository } from '@/lib/db/get-db';
import { getDecompStore } from '@/lib/dict/browser-store';
import type { SearchGroup } from '@/lib/dict/search';
import type { DecompCharacter } from '@/lib/dict/decomp-store';
import { addCardChecked } from '@/lib/lists/looked-up';
import { hskBandLabel, type CardContext, type Entry } from '@/lib/types';

/**
 * `idle` → `saving` → one of the three outcomes. They are three because the Add
 * has three outcomes: a new card, a card that was already there (the spine may
 * have drawn this word this morning), and a card that was already there but has
 * now been given the provenance this Add carried. Saying "Added" for all three
 * is how the panel came to claim a card it never wrote.
 */
type AddState = 'idle' | 'saving' | 'added' | 'enriched' | 'existing' | 'error';

function contextFor(query: string, context?: CardContext): CardContext {
  // A query that arrived from the reader or the ask panel already carries its own
  // provenance; only fill in what it is missing (§1, commitment 2).
  if (context) return { ...context, query: context.query ?? query };
  return { query, source: 'lookup', addedAt: Date.now() };
}

function Reading({
  entry,
  selected,
  onSelect,
  choosable,
}: {
  entry: Entry;
  selected: boolean;
  onSelect: (id: string) => void;
  choosable: boolean;
}) {
  return (
    <li
      className={cn(
        'rounded-lg border px-3 py-2',
        selected ? 'border-accent bg-accent-soft' : 'border-border',
      )}
    >
      <label className="touch-target flex cursor-pointer items-baseline gap-2">
        {choosable ? (
          <input
            type="radio"
            name="reading"
            data-testid="reading-option"
            value={entry.id}
            checked={selected}
            onChange={() => onSelect(entry.id)}
            className="accent-accent"
          />
        ) : null}
        <span className="text-base font-medium text-accent" data-testid="reading-pinyin">
          {entry.pinyinMarked || '—'}
        </span>
        {entry.hskBand ? <Badge tone="accent">HSK {hskBandLabel(entry.hskBand)}</Badge> : null}
        {entry.isVariant ? <Badge>variant</Badge> : null}
        {entry.properNoun ? <Badge>proper noun</Badge> : null}
      </label>
      <ol className="mt-1 list-inside list-decimal text-sm">
        {entry.glosses.map((gloss, i) => (
          // `entry-gloss` is the hook C4's in-context line is checked against:
          // the line may only name a sense that appears in this list.
          <li key={`${i}-${gloss}`} data-testid="entry-gloss" data-sense-index={i}>
            {gloss}
          </li>
        ))}
      </ol>
      {entry.classifiers.length > 0 ? (
        <p className="mt-1 text-xs text-muted">
          classifier <HanziWord text={entry.classifiers.join(' ')} />
        </p>
      ) : null}
    </li>
  );
}

export function EntryDetail({
  group,
  query,
  context,
  dictVersion,
  onSelectedChange,
  belowHeadword,
}: {
  group: SearchGroup;
  query: string;
  context?: CardContext;
  dictVersion?: string;
  /**
   * The reading the sheet is **showing**, reported as it changes.
   *
   * C4's word sheet needs it for "Mark known": the criterion is that a
   * polyphone whose sheet is showing reading B marks reading B's entry, not the
   * frequency-first one. The selection stays owned here — lifting it would mean
   * every other caller had to hold state it does not use — and this is the one
   * way out.
   */
  onSelectedChange?: (entry: Entry) => void;
  /**
   * A slot directly under the headword, for the in-context gloss line (C4).
   * It is a slot rather than a prop shape because C7 owns the ask module's
   * state and this component must not learn about it.
   */
  belowHeadword?: ReactNode;
}) {
  const go = useScreenNavigate();
  const [selectedId, setSelectedId] = useState(group.entries[0].id);
  // Both of these belong to one reading, so they carry the id they were made
  // for: switching readings must not leave the previous one's "In your cards"
  // (or its answer to "is this already a card?") on screen, and keying them is
  // how that reset happens during render rather than in an effect.
  const [outcome, setOutcome] = useState<{ id: string; state: AddState }>();
  const [probe, setProbe] = useState<{ id: string; carded: boolean }>();
  const [decomp, setDecomp] = useState<DecompCharacter[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Through `DecompStore` (core.md C4a). The `AbortSignal` the route client
    // took has no equivalent on the frozen interface; `cancelled` already drops
    // a late answer, and a decomposition that arrives for the previous headword
    // is dropped rather than rendered.
    getDecompStore()
      .decompose(group.simp)
      .then((characters) => {
        if (!cancelled) setDecomp(characters);
      })
      .catch(() => {
        // Decomposition is a nicety; a 503 here must not blank the entry.
        if (!cancelled) setDecomp([]);
      });
    return () => {
      cancelled = true;
    };
  }, [group.simp]);

  const entry = group.entries.find((candidate) => candidate.id === selectedId) ?? group.entries[0];
  // Reported after render, not inside the setter: `selectedId` also resets when
  // the group changes (the component is keyed on `group.key`), and a caller
  // that only heard about button presses would keep marking the previous word.
  useEffect(() => {
    onSelectedChange?.(entry);
  }, [entry, onSelectedChange]);
  /**
   * The syllable each character of the headword takes, under the reading the
   * learner has selected — for the "Characters" strip below, which is the one
   * screen in the app whose subject *is* individual characters and was the one
   * screen with no per-character reading on it.
   *
   * Keyed by character rather than by position because `decomp` is a list of
   * the headword's characters, and **a character that appears twice with two
   * different syllables gets none**: 好好 is hǎo hāo, and printing either over
   * both rows would be exactly the fabricated reading the grounding contract
   * forbids. A fallback alignment (`AA制`) yields an empty map, so the strip
   * stays plain there too.
   */
  const syllables = useMemo(() => {
    const alignment = alignReading(entry.simp, entry.pinyinNum);
    if (alignment.mode !== 'aligned') return new Map<string, string>();
    const byChar = new Map<string, string | null>();
    for (const { char, syllable } of alignment.chars) {
      if (!syllable) continue;
      const seen = byChar.get(char);
      byChar.set(char, seen === undefined || seen === syllable ? syllable : null);
    }
    return new Map(
      [...byChar].filter((pair): pair is [string, string] => pair[1] !== null),
    );
  }, [entry.pinyinNum, entry.simp]);
  const choosable = group.entries.length > 1;
  const state: AddState = outcome?.id === entry.id ? outcome.state : 'idle';
  const carded = probe?.id === entry.id ? probe.carded : undefined;
  const setState = (next: AddState) => setOutcome({ id: entry.id, state: next });

  // What the button should say before it is pressed: a word the spine drew this
  // morning is already a card, and offering a bare "Add card" hides that.
  useEffect(() => {
    let cancelled = false;
    getRepository()
      .cardForEntry(entry.id)
      .then((card) => {
        if (!cancelled) setProbe({ id: entry.id, carded: card !== undefined });
      })
      .catch(() => {
        if (!cancelled) setProbe({ id: entry.id, carded: false });
      });
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  const add = async () => {
    setState('saving');
    try {
      // `addCardChecked`, not the repository directly: an explicit Add also joins
      // the "Looked up" system list (P3, `lib/lists/looked-up.ts`), which is the
      // only record of where a card came from once the query is forgotten — and
      // it reports whether a card was actually written, so the line below can be
      // true rather than optimistic.
      const result = await addCardChecked(
        getRepository(),
        entry,
        contextFor(query, context),
        undefined,
        dictVersion,
      );
      setProbe({ id: entry.id, carded: true });
      setOutcome({
        id: entry.id,
        state: result.created ? 'added' : result.contextApplied ? 'enriched' : 'existing',
      });
    } catch {
      setState('error');
    }
  };

  const settled = state === 'added' || state === 'enriched' || state === 'existing';
  const carries = contextFor(query, context).query;

  return (
    <div data-testid="entry-detail" data-entry-id={entry.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted">
          {group.trad === group.simp ? (
            'Same in both scripts'
          ) : (
            <>
              traditional{' '}
              <HanziWord text={group.trad} pinyinNum={entry.pinyinNum} className="text-base text-ink" />
            </>
          )}
        </p>
        <Badge>{group.source} match</Badge>
      </div>

      {/*
        The in-context line, when the caller has one. Directly under the
        headword and **above** the readings, because it is the answer to "which
        of these", and below the readings it would be an afterthought to a
        question the learner has already had to guess at.
      */}
      {belowHeadword}

      {/*
        The speaker belongs to the word, so it sits at the head of the reading
        block — the same place the review card puts it (next to the pinyin), not
        out on the badge row two rows away from anything it speaks. It reads the
        simplified form because speech is a reading, not a script: a Mandarin
        voice says 學習 and 学习 identically, so the script preference the review
        card honours has nothing to change here.
      */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
          {choosable ? `Readings — choose one to add (${group.entries.length})` : 'Reading'}
        </h3>
        <SpeakButton text={group.simp} label={group.simp} />
      </div>
      <ul className="mt-2 flex flex-col gap-2" data-testid="reading-choice">
        {group.entries.map((candidate) => (
          <Reading
            key={candidate.id}
            entry={candidate}
            selected={candidate.id === selectedId}
            onSelect={setSelectedId}
            choosable={choosable}
          />
        ))}
      </ul>

      {decomp.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Characters</h3>
          <ul className="mt-2 flex flex-col gap-1" data-testid="decomposition">
            {decomp.map(({ char, entry: parts }) => (
              <li key={char} className="text-sm">
                {/*
                  The reading comes from the SELECTED entry's alignment, so it
                  changes with the reading the learner picks — and is absent
                  when the alignment cannot say which syllable this character
                  takes. `force`, because this strip is a reading surface: it
                  exists to answer "how is this character read".
                */}
                <HanziWord
                  text={char}
                  {...(syllables.has(char) ? { pinyinMarked: syllables.get(char) } : {})}
                  force
                  className="text-lg"
                />{' '}
                {parts ? (
                  <>
                    {/* An IDS string (⿰⿱…) plus its components — a
                        decomposition, not a word, so there is no reading to
                        annotate and `lang` is all it needs. */}
                    <span className="hanzi text-muted" lang="zh-Hans">
                      {parts.decomposition}
                    </span>
                    <span className="text-muted">
                      {' '}
                      · radical{' '}
                      <span className="hanzi" lang="zh-Hans">
                        {parts.radical}
                      </span>
                      {parts.definition ? ` · ${parts.definition}` : ''}
                    </span>
                  </>
                ) : (
                  <span className="text-muted">no decomposition</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          data-testid="add-card"
          data-carded={carded === true ? 'true' : 'false'}
          onClick={add}
          disabled={state === 'saving' || settled}
        >
          {settled
            ? 'In your cards'
            : state === 'saving'
              ? 'Adding…'
              : carded
                ? 'Already a card'
                : choosable
                  ? `Add ${entry.pinyinMarked || group.simp}`
                  : 'Add card'}
        </Button>
        {state === 'added' ? (
          <span className="text-sm text-accent" data-testid="add-state">
            Added to your cards — it carries “{carries}”.
          </span>
        ) : null}
        {state === 'enriched' ? (
          <span className="text-sm text-accent" data-testid="add-state">
            Already in your cards — it now carries “{carries}”.
          </span>
        ) : null}
        {state === 'existing' ? (
          <span className="text-sm text-muted" data-testid="add-state">
            Already in your cards.
          </span>
        ) : null}
        {state === 'error' ? (
          <span className="text-sm text-warning" data-testid="add-state">
            Could not save that card.
          </span>
        ) : null}
        {settled ? (
          // One way out since core.md C7: Today is a region of the Look up tab,
          // so "see it on Today" was the screen the learner is already on.
          <span className="text-sm text-muted">
            <button
              type="button"
              data-testid="practice-now"
              className="text-accent underline underline-offset-2"
              onClick={() => go({ tab: 'practice' })}
            >
              Practice now
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
