'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { WordSearch } from '@/components/lists/word-search';
import { WordStateBadge } from '@/components/lists/word-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getRepository } from '@/lib/db/get-db';
import type { CardRow, ListRow } from '@/lib/db/schema';
import { getEntrySource } from '@/lib/lists/entry-source';
import { queueFromList } from '@/lib/lists/introduce';
import { ensureMembers } from '@/lib/lists/members';
import { wordState, type WordState } from '@/lib/srs/states';
import type { Entry, EntryId } from '@/lib/types';

const PAGE = 50;

interface MemberView {
  entryId: EntryId;
  entry?: Entry;
  state: WordState;
  hasCard: boolean;
}

interface DetailData {
  list?: ListRow;
  missing: boolean;
  entryIds: EntryId[];
  members: MemberView[];
}

/**
 * Read everything the page shows, outside React: one list row, its membership
 * (materialised on this first visit if it is an HSK band), and the state of the
 * page of words being displayed.
 */
async function readDetail(listId: string, limit: number): Promise<DetailData> {
  const repo = getRepository();
  const source = getEntrySource();
  const row = (await repo.lists()).find((list) => list.id === listId);
  if (!row) return { missing: true, entryIds: [], members: [] };

  const settings = await repo.getSettings();
  const entryIds = (await ensureMembers(repo, row, source)).map((member) => member.entryId);
  const page = entryIds.slice(0, limit);
  const [entries, cards, known] = await Promise.all([
    source.entries(page),
    repo.allCards(),
    repo.knownEntryIds(),
  ]);

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const cardByEntry = new Map<string, CardRow>();
  for (const card of cards) if (card.entryId) cardByEntry.set(card.entryId, card);
  const knownIds = new Set(known);

  return {
    list: row,
    missing: false,
    entryIds,
    members: page.map((entryId) => {
      const entry = byId.get(entryId);
      const card = cardByEntry.get(entryId);
      return {
        entryId,
        entry,
        hasCard: card !== undefined,
        state: wordState({
          card: card?.fsrs ?? null,
          known: knownIds.has(entryId),
          ...(entry?.hskBand === undefined ? {} : { hskBand: entry.hskBand }),
          knownBand: settings.knownBand,
        }),
      };
    }),
  };
}

/**
 * One list, its words, and what state each is in (§3.3). Entries are fetched a
 * page at a time: HSK 7–9 is 5,622 members and nobody reads them all at once.
 */
export function ListDetail({ listId }: { listId: string }) {
  const [data, setData] = useState<DetailData>();
  const [shown, setShown] = useState(PAGE);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await readDetail(listId, shown);
        if (!cancelled) {
          setData(next);
          setError(undefined);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listId, shown, reload]);

  const list = data?.list;
  const entryIds = data?.entryIds ?? [];
  const members = data?.members ?? [];

  if (data?.missing) {
    return (
      <Card title="Not found">
        <p className="text-sm text-muted">
          That list does not exist.{' '}
          <Link href="/lists" className="text-accent underline underline-offset-2">
            Back to lists
          </Link>
          .
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        <Link href="/lists" className="text-accent underline underline-offset-2">
          ← All lists
        </Link>
      </p>

      {error ? (
        <p role="status" className="text-sm text-warning">
          {error}
        </p>
      ) : null}

      {list && list.kind !== 'hsk' ? (
        <Card title="Add a word">
          <WordSearch
            present={new Set(entryIds)}
            onAdd={async (entry) => {
              await getRepository().addListMembers(list.id, [entry.id]);
              setReload((value) => value + 1);
            }}
          />
        </Card>
      ) : null}

      <Card
        title={list?.name ?? 'List'}
        aside={
          <span className="flex items-center gap-2">
            {list ? <Badge>{list.kind}</Badge> : null}
            <span data-testid="member-total" className="text-sm text-muted">
              {entryIds.length} words
            </span>
          </span>
        }
      >
        {!data ? (
          <p className="text-sm text-muted">Loading words…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-muted">This list has no words yet.</p>
        ) : (
          <ul data-testid="list-members" className="flex flex-col divide-y divide-border">
            {members.map((member) => (
              <li
                key={member.entryId}
                data-testid="list-member"
                data-state={member.state}
                data-entry-id={member.entryId}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="min-w-0">
                  <span className="hanzi text-lg">{member.entry?.simp ?? member.entryId}</span>{' '}
                  <span className="text-sm text-muted">{member.entry?.pinyinMarked}</span>
                  <span className="block truncate text-sm text-muted">{member.entry?.glosses[0]}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <WordStateBadge state={member.state} />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={member.hasCard || !member.entry}
                    aria-label={`Add to queue: ${member.entry?.simp ?? member.entryId}`}
                    onClick={() => {
                      const entry = member.entry;
                      if (!entry) return;
                      void queueFromList(getRepository(), entry).then(() =>
                        setReload((value) => value + 1),
                      );
                    }}
                  >
                    {member.hasCard ? 'Queued' : 'Add to queue'}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {shown < entryIds.length ? (
          <div className="mt-3">
            <Button variant="ghost" size="sm" onClick={() => setShown((value) => value + PAGE)}>
              Show more ({entryIds.length - shown} left)
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
