'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getEntrySource } from '@/lib/lists/entry-source';
import type { Entry } from '@/lib/types';

/**
 * Add a word to a list by looking it up.
 *
 * TODO(merge): `EntrySource.search` calls `/api/dict/search` when P1's route is
 * there and otherwise walks the HSK bands. The fallback covers every word a
 * hand-made list plausibly holds; the route covers the rest of the dictionary.
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
        <Button type="submit" disabled={pending || !query.trim()}>
          {pending ? 'Searching…' : 'Find'}
        </Button>
      </form>

      {error ? <p className="text-sm text-warning">{error}</p> : null}

      {searched && results.length === 0 && !pending ? (
        <p className="text-sm text-muted">Nothing matched that.</p>
      ) : null}

      {results.length > 0 ? (
        <ul data-testid="word-search-results" className="flex flex-col divide-y divide-border">
          {results.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="hanzi text-lg">{entry.simp}</span>{' '}
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
