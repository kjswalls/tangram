/**
 * "Every explicit Add joins the Looked up list" (PLAN.md §3.3 provenance, §4 P3).
 *
 * `repository.addCardFromEntry` deliberately knows nothing about lists — it is
 * the frozen seam — so the join lives here, one call further out. P1 (lookup),
 * P4 (ask) and P5 (reader) should add through `addCardTracked` rather than
 * calling the repository directly; see HANDOFF-p3.md.
 */

import type { CardRow } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import { ensureSystemLists, findLookedUpList } from '@/lib/lists/system-lists';
import type { CardContext, ContextSource, Entry, EntryId } from '@/lib/types';

/** The three sources that mean "the learner chose this word", per §3.3. */
export const EXPLICIT_SOURCES: readonly ContextSource[] = ['lookup', 'ask', 'reader'];

export function isExplicitSource(source: ContextSource | undefined): boolean {
  return source !== undefined && EXPLICIT_SOURCES.includes(source);
}

/** Put entries in the "Looked up" list, creating the list if this is the first. */
export async function joinLookedUp(repo: Repository, entryIds: EntryId[]): Promise<void> {
  if (entryIds.length === 0) return;
  const lists = await ensureSystemLists(repo);
  const list = findLookedUpList(lists);
  if (!list) return;
  await repo.addListMembers(list.id, entryIds);
}

/**
 * Add a card the way the UI should: the repository call, plus the provenance
 * bookkeeping around it. Idempotent, because both halves are.
 */
export async function addCardTracked(
  repo: Repository,
  entry: Entry,
  context?: CardContext,
  senseIndex?: number,
  dictVersion?: string,
): Promise<CardRow> {
  const card = await repo.addCardFromEntry(entry, context, senseIndex, dictVersion);
  if (isExplicitSource(context?.source)) await joinLookedUp(repo, [entry.id]);
  return card;
}
