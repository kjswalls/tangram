/**
 * Which lists are set to "also study production" (Phase 8, builder B).
 *
 * **This is a stopgap and it is written down as one.** The flag belongs on the
 * `lists` row next to `active`, but `lib/db/schema.ts` is frozen for the four
 * Phase 8 builders (HANDOFF.md, Phase 8 prep §6), and the rule for a frozen file is to
 * stop, write the need down and continue without it. So the preference lives in
 * `localStorage` behind the three functions below, which are the whole seam: a
 * `production?: boolean` column on `ListRow` turns this file into three
 * repository calls and changes nothing above it. The need is recorded in
 * HANDOFF.md, Phase 8 (builder B).
 *
 * What is *not* at risk in the meantime: the cards. Turning the toggle on
 * writes real rows through the repository, and those are in IndexedDB like
 * everything else. Losing this key loses a preference — the twins already made
 * stay made, and the toggle comes back off.
 *
 * Reads and writes never throw. A browser with storage disabled, a private
 * window, a value some other tab mangled: all of them are "no lists are set",
 * which is the same answer a fresh install gives.
 */

export const PRODUCTION_LISTS_KEY = 'tangram:production-lists';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Some browsers throw on the *property access* when site data is blocked.
    return null;
  }
}

/** Every list id currently set to also study production. */
export function readProductionLists(store: StorageLike | null = storage()): Set<string> {
  if (!store) return new Set();
  try {
    const raw = store.getItem(PRODUCTION_LISTS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0));
  } catch {
    return new Set();
  }
}

export function isProductionList(listId: string, store?: StorageLike | null): boolean {
  return readProductionLists(store ?? storage()).has(listId);
}

/**
 * Turn a list's production study on or off. Returns the new set, so a caller
 * can render from what was actually stored rather than from what it asked for.
 *
 * Turning it *off* removes nothing: cards already made keep their schedules,
 * because a scheduled card is a commitment and silently dropping a due card is
 * how a queue starts lying about what is waiting.
 */
export function setProductionList(
  listId: string,
  on: boolean,
  store: StorageLike | null = storage(),
): Set<string> {
  const next = readProductionLists(store);
  if (on) next.add(listId);
  else next.delete(listId);
  try {
    store?.setItem(PRODUCTION_LISTS_KEY, JSON.stringify([...next]));
  } catch {
    // Storage full or blocked. The toggle still reflects this session; it will
    // simply be off again next time, which is the safe direction to fail in.
  }
  return next;
}
