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
 */

import type { FsrsWeights } from '@/lib/db/schema';
import { isValidWeightVector } from '@/lib/srs/params';

const KEY = 'tangram.fsrs.previous';

/** `null` is a real stored value — "before this, the defaults were in force". */
export type PreviousWeights = FsrsWeights | null;

interface Slot {
  saved: true;
  previous: PreviousWeights;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Safari with cookies blocked throws on the property itself.
    return null;
  }
}

/** Park what is in force now, before overwriting it. */
export function rememberPrevious(previous: PreviousWeights): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify({ saved: true, previous } satisfies Slot));
  } catch {
    // A full or refusing quota is not a reason to fail an Apply.
  }
}

/**
 * What Revert would restore, or `undefined` when there is nothing parked.
 * `null` means "the defaults", and is distinct from "nothing to revert to".
 */
export function readPrevious(): PreviousWeights | undefined {
  const store = storage();
  if (!store) return undefined;
  let raw: string | null;
  try {
    raw = store.getItem(KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('saved' in parsed)) return undefined;
    const previous = (parsed as Slot).previous;
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
  if (!store) return;
  try {
    store.removeItem(KEY);
  } catch {
    // Nothing to do and nothing worth reporting.
  }
}
