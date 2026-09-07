'use client';

import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { ListView } from '@/lib/stores/lists';

export interface ListCardProps {
  view: ListView;
  busy?: boolean;
  onToggleActive: (active: boolean) => void;
  onMarkAllKnown: () => void;
}

/**
 * One list. Active gates the auto-draw (§3.3), so the toggle is the primary
 * control and the counts are what tell you whether the list is worth drawing
 * from — how many words it holds, and how many of them you already know.
 */
export function ListCard({ view, busy, onToggleActive, onMarkAllKnown }: ListCardProps) {
  const { list, count, knownCount } = view;
  const allKnown = count > 0 && knownCount === count;

  return (
    <Card
      data-testid="list-card"
      data-list-name={list.name}
      data-list-kind={list.kind}
      data-list-band={list.band ?? ''}
      data-active={list.active ? 'true' : 'false'}
      title={
        <Link href={`/lists/${list.id}`} className="normal-case hover:text-accent">
          {list.name}
        </Link>
      }
      aside={<Badge tone={list.kind === 'hsk' ? 'neutral' : 'accent'}>{list.kind}</Badge>}
    >
      <p className="text-sm text-muted" data-testid="list-counts">
        {count > 0 ? (
          <>
            <span data-testid="list-count">{count}</span> words
            {knownCount > 0 ? <> · {knownCount} known</> : null}
          </>
        ) : (
          <span className="text-muted">no words yet</span>
        )}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={list.active}
            aria-label={`Active: ${list.name}`}
            onChange={(event) => onToggleActive(event.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Active
        </label>

        <Button
          variant="secondary"
          size="sm"
          disabled={busy || allKnown}
          onClick={onMarkAllKnown}
          aria-label={`Mark all known: ${list.name}`}
        >
          {allKnown ? 'All known' : busy ? 'Marking…' : 'Mark all known'}
        </Button>

        <Link href={`/lists/${list.id}`} className="text-sm text-accent underline underline-offset-2">
          Open
        </Link>
      </div>
    </Card>
  );
}
