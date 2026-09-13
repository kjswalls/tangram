'use client';

import { useEffect } from 'react';

import { CreateListForm } from '@/components/lists/create-list-form';
import { ListCard } from '@/components/lists/list-card';
import { Card } from '@/components/ui/card';
import { useListsStore } from '@/lib/stores/lists';

/**
 * `/lists`. The eight system lists are created on this first visit (§3.3) and
 * their membership is filled in behind the page, so the cards appear at once and
 * the counts arrive band by band rather than after a three-megabyte wait.
 */
export function ListsView() {
  const { views, loading, error, busy, filling, load, fillMembers, setActive, markAllKnown, createCustomList } =
    useListsStore();

  useEffect(() => {
    void load().then(() => fillMembers());
  }, [load, fillMembers]);

  return (
    <div className="flex flex-col gap-4">
      <Card title="New list">
        <CreateListForm onCreate={createCustomList} />
      </Card>

      {error ? (
        <p role="status" className="text-sm text-warning">
          {error}
        </p>
      ) : null}

      {views.length === 0 && loading ? <p className="text-sm text-muted">Loading lists…</p> : null}

      <div data-testid="lists" className="flex flex-col gap-3">
        {views.map((view) => (
          <ListCard
            key={view.list.id}
            view={view}
            busy={busy[view.list.id]}
            onToggleActive={(active) => void setActive(view.list.id, active)}
            onMarkAllKnown={() => void markAllKnown(view.list.id)}
          />
        ))}
      </div>

      {filling ? (
        <p data-testid="lists-filling" className="text-sm text-muted">
          Filling in the HSK lists from the dictionary…
        </p>
      ) : null}
    </div>
  );
}
