'use client';

import { useState } from 'react';

import { HanziWord } from '@/components/hanzi/hanzi-text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isDictUnavailable } from '@/lib/dict/unavailable';
import { getEntrySource } from '@/lib/lists/entry-source';
import type { Entry } from '@/lib/types';

/**
 * Add a word to a list by looking it up.
 *
 * `EntrySource.search` goes through `DictStore.search`, so this box and the
 * lookup box rank a query identically; walking the HSK bands is the offline
 * fallback for a 503 (HANDOFF.md, "Phases 1–3 (merged)").
 */
export function WordSearch({
  onAdd,
  present,
}: {
  onAdd: (entry: Entry) => Promise<unknown>;
  present: ReadonlySet<string>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entry[]>([]);
  const [searched, setSearched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const run = async () => {
    if (!query.trim()) return;
    setPending(true);
    setError(undefined);
    try {
      setResults(await getEntrySource().search(query.trim()));
      setSearched(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div data-testid="word-search" className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <Input
          aria-label="Find a word"
          placeholder="跑步, paobu, to run"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="max-w-xs"
        />
        {/* `secondary`, not the default `primary`: since C1 the primary variant
            is the screen's single filled vermillion action (§1), and a search
            submit inside a card is not it. On /lists/:id it sat next to the
            delete confirmation, which is. */}
        <Button type="submit" variant="secondary" disabled={pending || !query.trim()}>
          {pending ? 'Searching…' : 'Find'}
        </Button>
      </form>

      {/*
        **One error surface, and this box is not it** (docs/plans/web.md W6,
        part 2). Searching for a word to add is a dictionary read, so "no
        dictionary on this device" is the first thing it fails on — and it used
        to render the raw `Error.message` here as a lowercase fragment with
        nothing to press. But this box only ever appears inside
        `components/lists/list-detail.tsx`, which mounts `<DictNotice>` for the
        whole page, and two copies of the same card on one page is the defect
        rather than the fix. So the dictionary's absence is said once, up there,
        and everything else still says itself here.
      */}
      {error && !isDictUnavailable(error) ? (
        <p role="status" className="text-sm text-warning">
          {error}
        </p>
      ) : null}

      {searched && results.length === 0 && !pending ? (
        <p className="text-sm text-muted">Nothing matched that.</p>
      ) : null}

      {results.length > 0 ? (
        <ul data-testid="word-search-results" className="flex flex-col divide-y divide-border">
          {results.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <HanziWord text={entry.simp} pinyinNum={entry.pinyinNum} className="text-lg" />{' '}
                <span className="text-sm text-muted">{entry.pinyinMarked}</span>
                <span className="block truncate text-sm text-muted">{entry.glosses[0]}</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={present.has(entry.id)}
                aria-label={`Add ${entry.simp}`}
                onClick={() => void onAdd(entry)}
              >
                {present.has(entry.id) ? 'In list' : 'Add'}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
