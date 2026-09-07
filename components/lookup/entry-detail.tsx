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
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { getRepository } from '@/lib/db/get-db';
import { fetchDecomp } from '@/lib/dict/client';
import type { SearchGroup } from '@/lib/dict/search';
import type { DecompResponse } from '@/lib/dict/decomp';
import { addCardTracked } from '@/lib/lists/looked-up';
import { hskBandLabel, type CardContext, type Entry } from '@/lib/types';

type AddState = 'idle' | 'saving' | 'added' | 'error';

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
      <label className="flex cursor-pointer items-baseline gap-2">
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
          <li key={`${i}-${gloss}`}>{gloss}</li>
        ))}
      </ol>
      {entry.classifiers.length > 0 ? (
        <p className="mt-1 text-xs text-muted">
          classifier <span className="hanzi">{entry.classifiers.join(' ')}</span>
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
}: {
  group: SearchGroup;
  query: string;
  context?: CardContext;
  dictVersion?: string;
}) {
  const [selectedId, setSelectedId] = useState(group.entries[0].id);
  const [state, setState] = useState<AddState>('idle');
  const [decomp, setDecomp] = useState<DecompResponse['characters']>([]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    fetchDecomp(group.simp, { signal: controller.signal })
      .then((characters) => {
        if (!cancelled) setDecomp(characters);
      })
      .catch(() => {
        // Decomposition is a nicety; a 503 here must not blank the entry.
        if (!cancelled) setDecomp([]);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [group.simp]);

  const entry = group.entries.find((candidate) => candidate.id === selectedId) ?? group.entries[0];
  const choosable = group.entries.length > 1;

  const add = async () => {
    setState('saving');
    try {
      // `addCardTracked`, not the repository directly: an explicit Add also joins
      // the "Looked up" system list (P3, `lib/lists/looked-up.ts`), which is the
      // only record of where a card came from once the query is forgotten.
      await addCardTracked(
        getRepository(),
        entry,
        contextFor(query, context),
        undefined,
        dictVersion,
      );
      setState('added');
    } catch {
      setState('error');
    }
  };

  return (
    <div data-testid="entry-detail" data-entry-id={entry.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted">
          {group.trad === group.simp ? (
            'Same in both scripts'
          ) : (
            <>
              traditional <span className="hanzi text-base text-foreground">{group.trad}</span>
            </>
          )}
        </p>
        <Badge>{group.source} match</Badge>
      </div>

      <h3 className="mt-3 text-xs font-semibold tracking-wide text-muted uppercase">
        {choosable ? `Readings — choose one to add (${group.entries.length})` : 'Reading'}
      </h3>
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
                <span className="hanzi text-lg">{char}</span>{' '}
                {parts ? (
                  <>
                    <span className="hanzi text-muted">{parts.decomposition}</span>
                    <span className="text-muted">
                      {' '}
                      · radical <span className="hanzi">{parts.radical}</span>
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

      <div className="mt-4 flex items-center gap-3">
        <Button
          data-testid="add-card"
          onClick={add}
          disabled={state === 'saving' || state === 'added'}
        >
          {state === 'added'
            ? 'Added'
            : state === 'saving'
              ? 'Adding…'
              : choosable
                ? `Add ${entry.pinyinMarked || group.simp}`
                : 'Add card'}
        </Button>
        {state === 'added' ? (
          <span className="text-sm text-accent" data-testid="add-state">
            Added to your cards — it carries “{contextFor(query, context).query}”.
          </span>
        ) : null}
        {state === 'error' ? (
          <span className="text-sm text-warning" data-testid="add-state">
            Could not save that card.
          </span>
        ) : null}
      </div>
    </div>
  );
}
