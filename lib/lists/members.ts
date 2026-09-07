/**
 * List membership (PLAN.md §3.3, §4 P3).
 *
 * A list stores `entryId`s, never words: `list_members` for HSK 7–9 is 5,622
 * rows of a string, while the same list as `words` rows would be 5,622 snapshots
 * of a dictionary the app already has. A `words` row is created when a card is —
 * see `lib/lists/introduce.ts`.
 */

import type { ListMemberRow, ListRow } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import { getEntrySource, type EntrySource } from '@/lib/lists/entry-source';
import type { EntryId } from '@/lib/types';

/**
 * One materialisation per list at a time. Two callers can arrive together (the
 * lists page filling its counts and "Mark all known" on the same card), and
 * `addListMembers` de-duplicates against what it can already see — which is
 * nothing, if the other call has not committed yet.
 */
const inFlight = new Map<string, Promise<ListMemberRow[]>>();

async function materialise(
  repo: Repository,
  list: ListRow,
  source: EntrySource,
): Promise<ListMemberRow[]> {
  const existing = await repo.listMembers(list.id);
  if (existing.length > 0 || list.kind !== 'hsk' || list.band === undefined) return existing;
  const entries = await source.band(list.band);
  await repo.addListMembers(
    list.id,
    entries.map((entry) => entry.id),
  );
  return repo.listMembers(list.id);
}

/**
 * The list's members, filling an HSK list from the dictionary the first time it
 * is asked for. User lists are returned as they are — nothing to fill them from.
 */
export function ensureMembers(
  repo: Repository,
  list: ListRow,
  source: EntrySource = getEntrySource(),
): Promise<ListMemberRow[]> {
  const pending = inFlight.get(list.id);
  if (pending) return pending;
  const run = materialise(repo, list, source).finally(() => {
    inFlight.delete(list.id);
  });
  inFlight.set(list.id, run);
  return run;
}

export async function memberEntryIds(
  repo: Repository,
  list: ListRow,
  source?: EntrySource,
): Promise<EntryId[]> {
  return (await ensureMembers(repo, list, source)).map((row) => row.entryId);
}

/** Declare every word in the list known. Materialises the list if it has to. */
export async function markListKnown(
  repo: Repository,
  list: ListRow,
  source?: EntrySource,
): Promise<number> {
  const entryIds = await memberEntryIds(repo, list, source);
  if (entryIds.length === 0) return 0;
  await repo.markKnown(entryIds);
  return entryIds.length;
}
