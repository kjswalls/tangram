'use client';

import { Link, useNavigate } from 'react-router';
import { useEffect, useState } from 'react';

import { ProductionListToggle } from '@/components/lists/production-list-toggle';
import { WordSearch } from '@/components/lists/word-search';
import { WordStateBadge } from '@/components/lists/word-state';
import { Badge } from '@/components/ui/badge';
import { HanziWord } from '@/components/hanzi/hanzi-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getRepository } from '@/lib/db/get-db';
import type { CardRow, ListRow } from '@/lib/db/schema';
import { getEntrySource } from '@/lib/lists/entry-source';
import { queueFromList } from '@/lib/lists/introduce';
import { ensureMembers } from '@/lib/lists/members';
import { preferRecognition } from '@/lib/srs/direction';
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
  /**
   * An HSK band nobody has opened yet, whose membership the dictionary cannot
   * supply. Distinct from "no words": a custom list with nothing in it is the
   * learner's own empty list, while this one has words and they are out of
   * reach, so the two need different words on screen.
   */
  unfilled: boolean;
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
  if (!row) return { missing: true, unfilled: false, entryIds: [], members: [] };

  const settings = await repo.getSettings();
  /**
   * **The other half of "a dictionary that cannot answer must not take the list
   * with it"**, and the half the first fix missed. `ensureMembers` fills an HSK
   * band from `source.band()` the first time that band is opened, so on a fresh
   * install every one of the eight system lists rejects here when the
   * dictionary is down — before the guarded `entries()` call below is ever
   * reached. The rejection escaped `readDetail`, `data` stayed undefined, and
   * the page sat on "Loading words…" under a raw `run pnpm data` for ever, with
   * no retry.
   *
   * An unfilled band has no learner-owned ids to degrade to — its membership
   * *is* derived from the dictionary — so the honest answer is to say so, not
   * to render an empty list that looks like one the learner emptied.
   */
  let unfilled = false;
  const members = await ensureMembers(repo, row, source).catch(() => {
    unfilled = true;
    return [];
  });
  const entryIds = members.map((member) => member.entryId);
  const page = entryIds.slice(0, limit);
  const [entries, cards, known] = await Promise.all([
    /**
     * **A dictionary that cannot answer must not take the list with it**
     * (core.md C4a; `data.md` D4: "the app runs without a dictionary").
     *
     * A list is the learner's own data — ids in IndexedDB — and the dictionary
     * only supplies the gloss and the reading beside each one. Letting this
     * rejection propagate turned the whole page into an error message, so a
     * learner with no `data/` build could not see the words they had chosen.
     * The row below already renders a member whose entry is missing, by id; it
     * just never got the chance.
     */
    source.entries(page).catch(() => []),
    repo.allCards(),
    repo.knownEntryIds(),
  ]);

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  // A word can now carry two cards — one per direction (Phase 8). The row is
  // about the *word*, so it answers with the recognition card: a reverse added
  // this morning must not repaint a word learned in March as new.
  const cardByEntry = new Map<string, CardRow>();
  for (const card of cards) {
    if (!card.entryId) continue;
    cardByEntry.set(card.entryId, preferRecognition(cardByEntry.get(card.entryId), card));
  }
  const knownIds = new Set(known);

  return {
    list: row,
    missing: false,
    unfilled,
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
  // Deleting a list is two clicks, not a `confirm()`: it is the one destructive
  // control on the page and there is no undo behind it.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const navigate = useNavigate();

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
          <Link to="/lists" className="text-accent underline underline-offset-2">
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
        <Link to="/lists" className="text-accent underline underline-offset-2">
          ← All lists
        </Link>
      </p>

      {error ? (
        <p role="status" className="text-sm text-warning">
          {error}
        </p>
      ) : null}

      {list ? (
        <ProductionListToggle
          listId={list.id}
          entryIds={entryIds}
          onAdded={() => setReload((value) => value + 1)}
        />
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
          <p className="text-sm text-muted" data-testid="list-empty" data-unfilled={data.unfilled ? 'true' : 'false'}>
            {data.unfilled
              ? 'This list is drawn from the dictionary, which is not available on this device yet. Your own lists, your practice and your progress do not need it.'
              : 'This list has no words yet.'}
          </p>
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
                  {member.entry ? (
                    <HanziWord
                      text={member.entry.simp}
                      pinyinNum={member.entry.pinyinNum}
                      className="text-lg"
                    />
                  ) : (
                    // A member whose entry the dictionary no longer has: the id
                    // is not a word and must not be annotated as one.
                    <span className="hanzi text-lg" lang="zh-Hans">
                      {member.entryId}
                    </span>
                  )}{' '}
                  <span className="text-sm text-muted">{member.entry?.pinyinMarked}</span>
                  <span className="block truncate text-sm text-muted">
                    {member.entry?.glosses.slice(0, 3).join('; ')}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <WordStateBadge state={member.state} />
                  {list?.kind === 'custom' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="remove-member"
                      aria-label={`Remove from list: ${member.entry?.simp ?? member.entryId}`}
                      onClick={() => {
                        void getRepository()
                          .removeListMembers(list.id, [member.entryId])
                          .then(() => setReload((value) => value + 1));
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={member.hasCard || !member.entry}
                    aria-label={`Add to queue: ${member.entry?.simp ?? member.entryId}`}
                    onClick={() => {
                      const entry = member.entry;
                      if (!entry) return;
                      const dictVersion = getEntrySource().dictVersion?.();
                      void queueFromList(getRepository(), entry, {
                        now: Date.now(),
                        listId: list?.id ?? '',
                        ...(dictVersion === undefined ? {} : { dictVersion }),
                      }).then(() => setReload((value) => value + 1));
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

      {list?.kind === 'custom' ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          {confirmingDelete ? (
            <>
              <span>Delete “{list.name}” and its words? The cards you made stay.</span>
              <Button
                size="sm"
                data-testid="confirm-delete-list"
                onClick={() => {
                  void getRepository()
                    .deleteList(list.id)
                    .then(() => navigate('/lists'));
                }}
              >
                Delete list
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              data-testid="delete-list"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete this list
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
