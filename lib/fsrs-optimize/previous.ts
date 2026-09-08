/**
 * The one-click undo behind Apply.
 *
 * Applying a fit overwrites `settings.fsrsWeights`, and that column has room
 * for exactly one vector — the schema is frozen for Phase 8, so there is no
 * `previousFsrsWeights` to write and no migration to add one in a branch. The
 * previous value is therefore parked in `localStorage`, per browser, and Revert
 * writes it back through the ordinary `setSettings` path.
 *
 * What that costs, said plainly rather than hidden: the undo is per browser and
 * per profile, it does not survive clearing site data, and it is one deep. What
 * it is not is a way to lose the schedule — reverting to `null` is reverting to
 * the FSRS population defaults, which is always available whether or not this
 * slot has anything in it, and no review row is touched either way.
 *
 * **The slot is stamped, and it is the undo of one particular fit.** Being in
 * `localStorage` it outlives the database: `resetAll()` and `loadDemo()` clear
 * every Dexie table, and a slot left behind would sit there offering to
 * reinstate weights fitted to a review log that no longer exists — one click,
 * and the panel would say "Optimized from your 4,321 reviews" over an empty
 * history. Those two now call `forgetPrevious()` (lib/dev/seed.ts), and this
 * module refuses the slot anyway unless the `fittedAt` it was parked against
 * still matches the fit in force, which also covers the wipe that happened in
 * another tab, another device, or a build ago.
 */

import type { FsrsWeights } from '@/lib/db/schema';
import { isValidWeightVector } from '@/lib/srs/params';

const KEY = 'tangram.fsrs.previous';

/** `null` is a real stored value — "before this, the defaults were in force". */
export type PreviousWeights = FsrsWeights | null;

interface Slot {
  saved: true;
  previous: PreviousWeights;
  /**
   * The `fittedAt` of the fit this was the undo *of* — i.e. of the vector that
   * was written over `previous`. `null` for a slot parked by an older build,
   * which is not offered: an unstamped slot cannot be shown to belong to the
   * weights actually in force.
   */
  appliedAt: number | null;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Safari with cookies blocked throws on the property itself.
    return null;
  }
}

/**
 * Anyone watching the slot — the panel, through `useSyncExternalStore`.
 *
 * The slot is an external store: it is written by an Apply, by a Revert, and by
 * the database wipe two sections further down the same page. A component cannot
 * derive it from props, so it subscribes to it instead.
 */
const listeners = new Set<() => void>();

export function subscribePrevious(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * The raw stored string, or `null`. Stable between writes — which is what
 * `useSyncExternalStore` requires of a snapshot — where a parsed object would
 * be a new identity on every render.
 */
export function previousSnapshot(): string | null {
  const store = storage();
  if (!store) return null;
  try {
    return store.getItem(KEY);
  } catch {
    return null;
  }
}

/** There is no `localStorage` on the server, so there is no undo there either. */
export function previousServerSnapshot(): null {
  return null;
}

/**
 * Park what is in force now, before overwriting it.
 *
 * `appliedAt` is the `fittedAt` of the fit about to be applied, so `readPrevious`
 * can check that the slot still belongs to the weights the database holds.
 */
export function rememberPrevious(previous: PreviousWeights, appliedAt: number): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify({ saved: true, previous, appliedAt } satisfies Slot));
  } catch {
    // A full or refusing quota is not a reason to fail an Apply.
  }
  notify();
}

/**
 * What Revert would restore, or `undefined` when there is nothing parked.
 * `null` means "the defaults", and is distinct from "nothing to revert to".
 *
 * `current` is the fit in force — `settings.fsrsWeights`. A slot is only an undo
 * if the thing it undoes is still there: with no fit in force there is nothing
 * to revert *from*, and a slot stamped against some other fit belongs to a
 * history this database no longer has. Both cases return `undefined` rather
 * than offering a button that would install weights from a deleted review log.
 */
export function readPrevious(current: FsrsWeights | null): PreviousWeights | undefined {
  return parsePrevious(previousSnapshot(), current);
}

/** `readPrevious`, over a snapshot already in hand. */
export function parsePrevious(
  raw: string | null,
  current: FsrsWeights | null,
): PreviousWeights | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('saved' in parsed)) return undefined;
    const slot = parsed as Slot;
    if (current === null) return undefined;
    if (typeof slot.appliedAt !== 'number' || slot.appliedAt !== current.fittedAt) return undefined;
    const previous = slot.previous;
    if (previous === null) return null;
    // Anything that is not a weight vector this build can use is not a state
    // worth restoring; better no undo than an undo into a broken schedule.
    if (typeof previous !== 'object' || !isValidWeightVector((previous as FsrsWeights).w)) {
      return undefined;
    }
    return previous as FsrsWeights;
  } catch {
    return undefined;
  }
}

export function forgetPrevious(): void {
  const store = storage();
  try {
    store?.removeItem(KEY);
  } catch {
    // Nothing to do and nothing worth reporting.
  }
  notify();
}
