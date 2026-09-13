'use client';

/**
 * The lookup panel, opened by a tap in the text (PLAN.md §3.5).
 *
 * It is driven by the lookup store exactly as `/lookup` is — the reader calls
 * `openLookup({query, entryIds, context})` and this reads it back — so a card
 * added here goes through the same `EntryDetail`, the same reading choice for a
 * polyphone, and the same "Looked up" bookkeeping. Duplicating that would mean
 * two Add buttons with two ideas of what a card is.
 *
 * The one thing it does not do is search. Segmentation has already resolved the
 * token to its readings, and re-deriving them from the string would ask the
 * router to guess at what the DAG decided in context; `/api/dict/entries`
 * answers by id instead. A token the dictionary has no headword for
 * (`via: 'fallback'`) has no ids, and only then does the panel fall back to
 * `/api/dict/search`.
 *
 * On a phone it is a bottom sheet; from `md` up it is the second column. One
 * instance either way — two would mean two decomposition fetches and two
 * answers to "is this already a card?".
 */

import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';

import { EntryDetail } from '@/components/lookup/entry-detail';
import { LookupPanel } from '@/components/lookup/lookup-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getRepository } from '@/lib/db/get-db';
import { fetchEntriesResponse, fetchSearch } from '@/lib/dict/client';
import type { SearchGroup } from '@/lib/dict/search';
import { useLookupStore } from '@/lib/stores/lookup';
import type { Entry, HskBand } from '@/lib/types';

/** One headword's readings, in the shape `EntryDetail` renders. */
export function groupFromEntries(entries: readonly Entry[]): SearchGroup | undefined {
  if (entries.length === 0) return undefined;
  const [first] = entries;
  const bands = entries.map((entry) => entry.hskBand).filter((band): band is HskBand => band !== undefined);
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

interface Resolved {
  query: string;
  group?: SearchGroup;
  dictVersion?: string;
  error?: string;
}

export interface ReaderLookupProps {
  /** Extend the span over the next token; absent when there is nothing to extend to. */
  onExtend?: () => void;
  /** Label for the extend button, e.g. `Extend to 明天`. */
  extendLabel?: string;
  onClose: () => void;
}

export function ReaderLookup({ onExtend, extendLabel, onClose }: ReaderLookupProps) {
  const query = useLookupStore((state) => state.query);
  const context = useLookupStore((state) => state.context);
  const entryIds = useLookupStore((state) => state.entryIds);

  const [resolved, setResolved] = useState<Resolved>();
  const [markError, setMarkError] = useState(false);

  /**
   * Read live, not remembered locally. Local `marked` state answered "did *this
   * mount* press the button", which said "Mark known" over a word that already
   * was, and kept saying "Marked known" after an Add had un-known it. The three
   * writers here — this button, an Add through `EntryDetail`, and the demo seed
   * — all move the same `known_words` rows, so the button reads the rows.
   */
  const known = useLiveQuery(async () => new Set(await getRepository().knownEntryIds()), []);

  useEffect(() => {
    // Nothing to resolve, and nothing to clear: `showing` below is gated on the
    // resolved answer being for *this* query, so a stale one never renders.
    if (!query) return;
    let cancelled = false;
    const controller = new AbortController();
    const options = { signal: controller.signal };

    void (async () => {
      try {
        if (entryIds && entryIds.length > 0) {
          const body = await fetchEntriesResponse(entryIds, options);
          if (cancelled) return;
          setResolved({
            query,
            group: groupFromEntries(body.entries),
            dictVersion: body.meta.version,
          });
          return;
        }
        // No ids: a run the dictionary has no headword for, or an extended span.
        const result = await fetchSearch(query, options);
        if (cancelled) return;
        setResolved({ query, group: result.groups[0], dictVersion: result.dictVersion });
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setResolved({ query, error: 'Could not reach the dictionary.' });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [query, entryIds]);

  const showing = resolved?.query === query ? resolved : undefined;
  const group = showing?.group;
  // The reading segmentation ranked first — the same one `EntryDetail`
  // preselects, and `entryIds` is frequency-ordered (§3.2).
  const primary = group?.entries[0];
  const alreadyMarked = primary !== undefined && (known?.has(primary.id) ?? false);

  const markKnown = async () => {
    if (!primary) return;
    setMarkError(false);
    try {
      await getRepository().markKnown([primary.id]);
    } catch {
      setMarkError(true);
    }
  };

  return (
    <div
      data-testid="reader-panel"
      className={
        'fixed inset-x-0 bottom-0 z-30 max-h-[65dvh] overflow-y-auto border-t border-border ' +
        'bg-surface shadow-[0_-8px_24px_rgba(0,0,0,0.12)] md:static md:max-h-none md:overflow-visible ' +
        'md:border-0 md:bg-transparent md:shadow-none'
      }
    >
      <LookupPanel query={query} context={context}>
        {showing?.error ? (
          <p className="text-sm text-warning">{showing.error}</p>
        ) : group ? (
          <EntryDetail
            key={group.key}
            group={group}
            query={query}
            context={context}
            dictVersion={showing?.dictVersion}
          />
        ) : showing ? (
          <p className="text-sm text-muted">
            The dictionary has no headword for “{query}”. It is still a word — it is just not one
            CC-CEDICT lists.
          </p>
        ) : (
          <p className="text-sm text-muted">Looking it up…</p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <Button
            data-testid="mark-known"
            variant="secondary"
            size="sm"
            onClick={markKnown}
            disabled={!primary || alreadyMarked}
          >
            {alreadyMarked ? 'Marked known' : 'Mark known'}
          </Button>
          {onExtend ? (
            <Button data-testid="extend-span" variant="secondary" size="sm" onClick={onExtend}>
              {extendLabel ?? 'Extend'}
            </Button>
          ) : null}
          <Button data-testid="close-panel" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          {alreadyMarked ? (
            <Badge tone="accent">
              <span className="hanzi">{primary?.simp}</span>
              <span className="ml-1">is known</span>
            </Badge>
          ) : null}
          {markError ? (
            <span className="text-sm text-warning">Could not mark that known.</span>
          ) : null}
        </div>

        {group && group.entries.length > 1 && !alreadyMarked ? (
          <p className="mt-2 text-xs text-muted">
            “Mark known” takes the most frequent reading ({primary?.pinyinMarked}); the other
            readings keep their own colour.
          </p>
        ) : null}
      </LookupPanel>
    </div>
  );
}
