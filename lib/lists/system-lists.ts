/**
 * The lists every install has (PLAN.md §3.3, §4 P3).
 *
 * Seven HSK bands plus "Looked up", created **lazily on first visit** — a fresh
 * database has no rows until something asks for them. Only the `lists` rows are
 * created here; membership (`list_members`) is materialised per list in
 * `lib/lists/members.ts`, and a `words` row appears only when a card does.
 *
 * What is lazy and what is not: no `words` row is ever inserted for a word the
 * learner has not met, but `list_members` is not lazy in practice — the first
 * visit to `/lists` calls `fillMembers()`, which materialises all seven bands
 * (11,028 `entryId` rows) so the counts on the index are real. Opening one list
 * would fill only that band.
 */

import type { ListRow } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import { HSK_BANDS, hskBandLabel, type HskBand } from '@/lib/types';

export const LOOKED_UP_LIST_NAME = 'Looked up';

export function hskListName(band: HskBand): string {
  return `HSK ${hskBandLabel(band)}`;
}

export interface SystemListSpec {
  name: string;
  kind: ListRow['kind'];
  band?: HskBand;
  order: number;
}

/**
 * "Looked up" leads: it is the only one of the eight the learner writes to by
 * using the app, and the auto-draw walks non-HSK lists before the spine.
 */
export const SYSTEM_LISTS: readonly SystemListSpec[] = [
  { name: LOOKED_UP_LIST_NAME, kind: 'looked-up', order: 0 },
  ...HSK_BANDS.map((band, i) => ({
    name: hskListName(band),
    kind: 'hsk' as const,
    band,
    order: i + 1,
  })),
];

function matches(row: ListRow, spec: SystemListSpec): boolean {
  return spec.kind === 'hsk' ? row.kind === 'hsk' && row.band === spec.band : row.kind === spec.kind;
}

/**
 * Two components can mount at once (the Today draw and the lists page), so the
 * whole read-then-create is shared through one in-flight promise per
 * repository. That memo is an optimisation, not the guarantee: it holds inside
 * one JS context and a second tab is a second context. The guarantee is in the
 * database — `lists.systemKey` is unique (`lib/db/schema.ts`) and `createList`
 * checks for the row and inserts it in one transaction — so two tabs arriving
 * together end up with one set of eight lists whatever this map believes.
 */
const inFlight = new WeakMap<Repository, Promise<ListRow[]>>();

async function create(repo: Repository): Promise<ListRow[]> {
  const existing = await repo.lists();
  for (const spec of SYSTEM_LISTS) {
    if (existing.some((row) => matches(row, spec))) continue;
    // `createList` is idempotent for a system list: it returns the row another
    // tab committed in the moment between the read above and this call.
    await repo.createList({
      name: spec.name,
      owner: 'system',
      kind: spec.kind,
      ...(spec.band === undefined ? {} : { band: spec.band }),
      active: true,
      order: spec.order,
    });
  }
  return repo.lists();
}

/** Every list, with the eight system lists created if they were missing. */
export function ensureSystemLists(repo: Repository): Promise<ListRow[]> {
  const pending = inFlight.get(repo);
  if (pending) return pending;
  const run = create(repo).finally(() => {
    inFlight.delete(repo);
  });
  inFlight.set(repo, run);
  return run;
}

export function findHskList(lists: readonly ListRow[], band: HskBand): ListRow | undefined {
  return lists.find((row) => row.kind === 'hsk' && row.band === band);
}

export function findLookedUpList(lists: readonly ListRow[]): ListRow | undefined {
  return lists.find((row) => row.kind === 'looked-up');
}

/** HSK lists, band ascending — the order the spine draws them in. */
export function hskLists(lists: readonly ListRow[]): ListRow[] {
  return lists
    .filter((row): row is ListRow & { band: HskBand } => row.kind === 'hsk' && row.band !== undefined)
    .sort((a, b) => a.band - b.band);
}

/** Everything that is not an HSK band, in list order: the user's own lists. */
export function userLists(lists: readonly ListRow[]): ListRow[] {
  return lists.filter((row) => row.kind !== 'hsk').sort((a, b) => a.order - b.order);
}
