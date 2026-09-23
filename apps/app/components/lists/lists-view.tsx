'use client';

import { useEffect } from 'react';

import { CreateListForm } from '@/components/lists/create-list-form';
import { ImportList } from '@/components/lists/import-list';
import { ListCard } from '@/components/lists/list-card';
import { DictNotice } from '@/components/dict/dict-gate';
import { Card } from '@/components/ui/card';
import { isDictUnavailable } from '@/lib/dict/unavailable';
import { useListsStore } from '@/lib/stores/lists';

/**
 * `/lists`. The eight system lists are created on this first visit (§3.3) and
 * their membership is filled in behind the page, so the cards appear at once and
 * the counts arrive band by band rather than after a three-megabyte wait.
 */
export function ListsView() {
  const {
    lists,
    views,
    loading,
    error,
    busy,
    filling,
    load,
    fillMembers,
    setActive,
    markAllKnown,
    createCustomList,
  } = useListsStore();

  useEffect(() => {
    void load().then(() => fillMembers());
  }, [load, fillMembers]);

  return (
    <div className="flex flex-col gap-4">
      <Card title="New list">
        <CreateListForm onCreate={createCustomList} />
      </Card>

      {/*
        Import, collapsed until it is asked for (`wave-zero.md` §8a). Library is
        a shelf a learner visits to do one thing, and a six-row textarea above
        the lists every visit is the wrong default for the rarer of the two ways
        to make a list.
      */}
      <Card title="Import a list">
        <ImportList lists={lists} onImported={() => void load()} />
      </Card>

      {/*
        **The one error surface** (docs/plans/web.md W6, part 2).

        The HSK lists are filled from the dictionary, so "no dictionary" is the
        failure this screen hits first — and it used to render the raw
        `Error.message` as a bare lowercase fragment floating here, between the
        New list card and the lists, with no sentence around it and nothing to
        press. It is the same card the other two tabs show now, which names the
        size and carries the button.

        Everything else keeps a line, but inside a card: a sentence on the page
        ground with no container was the shape of the defect as much as the
        wording was.
      */}
      {error && isDictUnavailable(error) ? <DictNotice /> : null}
      {error && !isDictUnavailable(error) ? (
        <Card data-testid="lists-error">
          <p role="status" className="text-sm text-warning">
            {error}
          </p>
        </Card>
      ) : null}

      {views.length === 0 && loading ? <p className="text-sm text-muted">Loading lists…</p> : null}

      <div data-testid="lists" className="flex flex-col gap-3">
        {views.map((view) => (
          <ListCard
            key={view.list.id}
            view={view}
            busy={busy[view.list.id]}
            filling={filling}
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
