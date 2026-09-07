'use client';

/**
 * The result list: one row per headword, never per entry (PLAN.md §3.2).
 *
 * A row carries everything needed to decide "is this the word I meant" without
 * opening it — both scripts, every reading, the first glosses, the classifier, the
 * HSK band, and which index answered — because the alternative is a list of
 * identical hanzi that can only be told apart by opening each one.
 */
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { MatchSource, SearchGroup, SearchSection } from '@/lib/dict/search';
import { hskBandLabel } from '@/lib/types';

const SOURCE_TITLE: Record<MatchSource, string> = {
  hanzi: 'Matched the characters you typed',
  pinyin: 'Matched the reading you typed',
  english: 'Matched an English gloss',
};

/** Distinct readings of a headword, matched ones first (the group is built that way). */
function readings(group: SearchGroup): { id: string; text: string; matched: boolean }[] {
  const seen = new Set<string>();
  const out: { id: string; text: string; matched: boolean }[] = [];
  for (const entry of group.entries) {
    const text = entry.pinyinMarked || '—';
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ id: entry.id, text, matched: group.matchedIds.includes(entry.id) });
  }
  return out;
}

export function ResultRow({
  group,
  selected,
  onSelect,
}: {
  group: SearchGroup;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const first = group.entries[0];
  return (
    <li>
      <button
        type="button"
        data-testid="search-result"
        data-key={group.key}
        data-source={group.source}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(group.key)}
        className={cn(
          'w-full rounded-lg border px-3 py-3 text-left transition',
          selected ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:border-accent',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="hanzi text-2xl leading-tight">
              {group.simp}
              {group.trad !== group.simp ? (
                <span className="ml-2 text-base text-muted">{group.trad}</span>
              ) : null}
            </p>
            <p className="mt-1 text-sm" data-testid="result-readings">
              {readings(group).map((reading, i) => (
                <span key={reading.id}>
                  {i > 0 ? <span className="text-muted"> · </span> : null}
                  <span className={reading.matched ? 'text-accent' : 'text-muted'}>
                    {reading.text}
                  </span>
                </span>
              ))}
            </p>
            <p className="mt-1 line-clamp-2 text-sm text-muted">
              {first.glosses.slice(0, 3).join('; ')}
            </p>
            {first.classifiers.length > 0 ? (
              <p className="mt-1 text-xs text-muted">
                CL <span className="hanzi">{first.classifiers.join(' ')}</span>
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {group.hskBand ? (
              <Badge tone="accent" data-testid="hsk-badge">
                HSK {hskBandLabel(group.hskBand)}
              </Badge>
            ) : null}
            <Badge data-testid="match-source" title={SOURCE_TITLE[group.source]}>
              {group.source}
            </Badge>
          </div>
        </div>
      </button>
    </li>
  );
}

export function SearchResults({
  sections,
  total,
  shown,
  resultQuery,
  selectedKey,
  onSelect,
  onShowMore,
  showingMore,
  hasMore,
}: {
  sections: SearchSection[];
  total: number;
  shown: number;
  /** The query these results answer — `data-query`, so a test can wait for it. */
  resultQuery: string;
  selectedKey?: string;
  onSelect: (key: string) => void;
  onShowMore: () => void;
  showingMore: boolean;
  hasMore: boolean;
}) {
  return (
    <div data-testid="search-results" data-query={resultQuery}>
      <p className="mb-2 text-xs text-muted" data-testid="result-count">
        {total === 0 ? 'No matches' : shown < total ? `${shown} of ${total} results` : `${total} result${total === 1 ? '' : 's'}`}
      </p>
      {sections.map((part) => (
        <section key={part.source} className="mb-4" data-testid={`section-${part.source}`}>
          {sections.length > 1 ? (
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
              {part.label}
            </h3>
          ) : null}
          <ul className="flex flex-col gap-2">
            {part.groups.map((group) => (
              <ResultRow
                key={group.key}
                group={group}
                selected={group.key === selectedKey}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </section>
      ))}
      {hasMore ? (
        <Button
          variant="secondary"
          size="sm"
          data-testid="show-more"
          disabled={showingMore}
          onClick={onShowMore}
        >
          {showingMore ? 'Loading…' : 'Show more'}
        </Button>
      ) : null}
    </div>
  );
}
