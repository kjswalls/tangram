'use client';

/**
 * "Also study production" for one list (Phase 8, builder B).
 *
 * The list is where a learner decides what a body of words is *for*, so it is
 * where the second direction belongs: turn it on for HSK 2 and the words in it
 * you have already started get a meaning → hanzi twin as well.
 *
 * Three rules, all of them about not wrecking an established queue:
 *
 *  1. **It is capped.** Each pass creates at most the day's remaining new-card
 *     allowance (`buildQueue(...).drawLimit`) and spends it, exactly as a
 *     list's "Add to queue" does. Ninety started words do not become ninety new
 *     cards tonight; they arrive at `newPerDay` a day, and the line under the
 *     toggle says how many are still waiting.
 *  2. **It only twins words already being learned.** A word whose recognition
 *     card is still New has not been recognised once; asking for it in
 *     production is not the next step (`requireStarted`).
 *  3. **Turning it off deletes nothing.** The twins already made keep their
 *     schedules — a scheduled card is a commitment, and a queue that silently
 *     drops due cards is a queue that lies about what is waiting. Off means no
 *     more are made.
 *
 * The on/off flag itself lives in `localStorage` (`lib/srs/direction-prefs.ts`)
 * because `ListRow` is frozen for Phase 8. The cards are in IndexedDB like
 * everything else; only the preference is at stake. See HANDOFF.md, Phase 8 (builder B).
 */

import { useEffect, useState } from 'react';

import { getRepository } from '@/lib/db/get-db';
import type { Repository } from '@/lib/db/repository';
import type { EntryId } from '@/lib/types';
import { addProductionTwins } from '@/lib/srs/direction';
import { isProductionList, setProductionList } from '@/lib/srs/direction-prefs';

export interface ProductionListToggleProps {
  listId: string;
  /** The list's entries, in list order. */
  entryIds: readonly EntryId[];
  /** Injected by tests; production reads the repository. */
  repo?: Repository;
  /** Cards were created, so the page around this is now stale. */
  onAdded?: () => void;
}

interface Status {
  created: number;
  pending: number;
}

/**
 * One top-up at a time per list. React mounts a page twice under StrictMode and
 * a fast re-navigation does it again; two passes would each read "no twin yet"
 * for the same word. The write is idempotent, so the worst case is a wasted
 * allowance rather than a duplicate card — but a wasted allowance is a new word
 * the learner did not get today.
 */
const running = new Set<string>();

export function ProductionListToggle({
  listId,
  entryIds,
  repo,
  onAdded,
}: ProductionListToggleProps) {
  const [enabled, setEnabled] = useState(false);
  const [on, setOn] = useState(false);
  /**
   * "A pass is running because you just asked for one." It is set from the
   * checkbox rather than from the effect below, because a synchronous
   * `setState` inside an effect is a cascading render.
   */
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await (repo ?? getRepository()).getSettings();
        if (!cancelled) setEnabled(settings.productionDirection === true);
      } catch {
        if (!cancelled) setEnabled(false);
      }
      if (!cancelled) setOn(isProductionList(listId));
    })();
    return () => {
      cancelled = true;
    };
  }, [listId, repo]);

  /**
   * On, while the page is open, means "keep it topped up": today's remaining
   * allowance is spent on this list's reverses whenever it is looked at. That
   * is what makes the toggle a standing choice rather than a one-off button,
   * and it is the same bargain Today already strikes — opening the page is what
   * introduces the day's words (`lib/lists/today.ts`).
   *
   * The work is inline rather than a callback because every `setState` here has
   * to land *after* an await: a synchronous one inside an effect is a cascading
   * render (and a lint error).
   */
  useEffect(() => {
    if (!enabled || !on || entryIds.length === 0) return;
    if (running.has(listId)) return;
    running.add(listId);
    let cancelled = false;
    void (async () => {
      try {
        const outcome = await addProductionTwins({
          repo: repo ?? getRepository(),
          entryIds,
          charge: true,
          source: 'list',
        });
        if (!cancelled) {
          setStatus({ created: outcome.created.length, pending: outcome.pending });
          setError(undefined);
          setWorking(false);
        }
        if (outcome.created.length > 0) onAdded?.();
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setWorking(false);
        }
      } finally {
        running.delete(listId);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Once per list per visit. `entryIds` grows as the page pages through its
    // members and `onAdded` is a fresh closure each render; re-running on
    // either would spend the allowance again for the same list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, on, listId]);

  if (!enabled) return null;

  return (
    <div data-testid="list-production" data-on={on ? 'true' : 'false'} className="text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          data-testid="list-production-toggle"
          className="h-4 w-4 accent-[var(--accent)]"
          checked={on}
          aria-label="Also study production for this list"
          onChange={(event) => {
            const next = event.target.checked;
            setProductionList(listId, next);
            setOn(next);
            setWorking(next);
            if (!next) setStatus(undefined);
          }}
        />
        Also study production (meaning → hanzi)
      </label>

      <p data-testid="list-production-status" className="mt-1 text-xs text-muted">
        {!on ? (
          'Off. The words here are asked one way round: hanzi → meaning.'
        ) : working ? (
          'Adding reverse cards…'
        ) : status ? (
          <>
            {status.created > 0
              ? `${status.created} reverse card${status.created === 1 ? '' : 's'} added today.`
              : 'No reverse cards added today.'}{' '}
            {status.pending > 0
              ? `${status.pending} more are waiting for a later day's allowance.`
              : 'Every started word in this list has one.'}
          </>
        ) : (
          'On. Words you have started here get a reverse card, under the daily new-card cap.'
        )}
      </p>

      {error ? (
        <p role="status" className="mt-1 text-xs text-warning">
          {error}
        </p>
      ) : null}
    </div>
  );
}
