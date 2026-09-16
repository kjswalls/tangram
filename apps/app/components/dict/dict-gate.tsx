'use client';

/**
 * What a dictionary surface renders when the dictionary is not there
 * (docs/plans/core.md C4a).
 *
 * Four states, one component, and the rule that decides which surfaces use it:
 * **the app keeps working without a dictionary.** Practice, lists and stats are
 * the learner's own data and are unaffected — they must not be gated. Lookup
 * and the reader are what degrade, and they are what this wraps.
 *
 * `ready` is the state with no screen: the gate renders its children and
 * nothing else. That is why this is a wrapper rather than a banner — a banner
 * above a broken search box tells the learner that something is wrong *and*
 * leaves them typing into it.
 *
 * It replaces `components/shell/data-banner.tsx` one-for-one (`data.md` D4 says
 * so), including that file's `HEAD` probe of the HSK route.
 *
 * **What the mount costs is the whole of this component's history.** That probe
 * became `store.open()`; `data.md` D6 then pointed `browser-store.ts` at the
 * OPFS store, and the same line came to mean *download 43 MB* — silently, with
 * no ask, which made the `absent` card below (the one carrying the size, which
 * `components/dict/dict-status.tsx` says exists because "a silent 14 MB
 * download on a metered connection is a hostile default") unreachable. The
 * mount is `openStored()` now: it opens what this origin already has and
 * fetches nothing, so a returning learner sees no gate and a new one sees the
 * ask. `download()` is behind the button.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { DictStatusView, type DictSource } from '@/components/dict/dict-status';
import { getDictOpener, getDictStore, type DictOpener } from '@/lib/dict/browser-store';
import type { DictStatus, DictStore } from '@/lib/dict/store';

/**
 * The store's status, live, and whether the first open has answered yet.
 *
 * Subscribes before reading, so a status that changes between the two is not
 * lost — the open resolves in a microtask and a read-then-subscribe would miss
 * a store that was already warm.
 *
 * The mount opens **only what is already stored**. That is the half of the
 * two-phase open a learner never sees: it is how a second visit, a second tab
 * and a reload get their dictionary back without being asked again, and how a
 * first visit settles in `absent` instead of downloading unannounced.
 *
 * **`checking` is the state `DictStatus` cannot hold.** A probe fetches nothing
 * and reports nothing (`SqliteStoreOptions.announceOpen`), so while it runs the
 * status is still the `absent` it started in — which is the *ask*, a card with a
 * button, and drawing it before the probe has answered would flash it at a
 * learner who has the dictionary and put a live button under a finger for an
 * instant. The fifth state this wants is a change to a frozen surface
 * (`lib/dict/store.ts`, `data.md` D1's first commit), so it is kept here, where
 * it is one boolean and no schema at all. HANDOFF.md records the need.
 */
export function useDictStatus(
  store: DictStore = getDictStore(),
  opener?: DictOpener,
): { status: DictStatus; checking: boolean } {
  const [status, setStatus] = useState<DictStatus>(() => store.status);
  const [checking, setChecking] = useState(true);
  // Resolved here rather than in a default argument, because `getDictOpener()`
  // returns a fresh object for any store this app did not build: as a default
  // argument it would be a new value every render, and the effect below would
  // unsubscribe, resubscribe and re-open on every keystroke elsewhere on the
  // page. The memo is inside the hook so that every caller gets it, not only
  // the one component that remembered to write one.
  const resolved = useMemo(() => opener ?? getDictOpener(store), [opener, store]);

  useEffect(() => {
    let live = true;
    const unsubscribe = store.subscribe(setStatus);
    setStatus(store.status);
    setChecking(true);
    // `openStored()` does not reject — "nothing stored" is a state — but the
    // rejection is swallowed anyway, here and nowhere else: a `void` on a
    // rejecting promise is an unhandled rejection that fails a Playwright run
    // on a page error, and a stand-in opener's `open()` can still reject.
    // Nothing is lost — the failure is already on `status`, with its reason,
    // which is what this component renders.
    void resolved
      .openStored()
      .catch(() => undefined)
      .finally(() => {
        if (live) setChecking(false);
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [store, resolved]);

  return { status, checking };
}

export interface DictGateProps {
  children: ReactNode;
  /** Download on the web; an asset copy on a phone's first launch. */
  source?: DictSource;
  store?: DictStore;
  /**
   * The two-phase open. Defaults to the one for `store`; a test or the gallery
   * passes its own rather than reaching for the app's handle.
   */
  opener?: DictOpener;
  /** Rendered above the children when ready — nothing, by design. */
  className?: string;
}

export function DictGate({ children, source, store, opener, className }: DictGateProps) {
  const surface = useDictSurface(store, opener);
  if (surface.status.state === 'ready') return <>{children}</>;
  return (
    <div
      data-testid="dict-gate"
      data-state={surface.status.state}
      {...(surface.undecided ? { 'data-checking': 'true' } : {})}
      className={className}
    >
      <DictSurface surface={surface} {...(source === undefined ? {} : { source })} />
    </div>
  );
}

/**
 * **The same surface, without the gate around it** (docs/plans/web.md W6).
 *
 * Practice and Library are the learner's own data and must never be gated
 * (`data.md` D4, C4a) — but both of them *do* something that needs the
 * dictionary, and when it is missing both used to say so in their own words and
 * their own shape. On Library the result was a bare lowercase fragment floating
 * between the New list card and the lists: no sentence around it, and no way to
 * act on it.
 *
 * So the screens render **this**, which is `<DictGate>`'s own card — the one
 * that names the size and carries the button — and nothing else. One fact, one
 * surface, one shape, on all three tabs, and the learner is never told the
 * dictionary is missing without being given the way to get it.
 *
 * It renders `null` when the dictionary is ready or the probe has not answered,
 * so a screen can mount it unconditionally beside whatever it was going to say.
 * A screen that is *already* inside a `<DictGate>` must not also mount one — on
 * Look up the gate above the search box is the surface, and Today saying the
 * same thing again underneath it is the duplicate W6 part 2 removes.
 */
export function DictNotice({ source, store, opener, className }: Omit<DictGateProps, 'children'>) {
  const surface = useDictSurface(store, opener);
  if (surface.status.state === 'ready' || surface.undecided) return null;
  return (
    <div data-testid="dict-notice" data-state={surface.status.state} className={className}>
      <DictSurface surface={surface} {...(source === undefined ? {} : { source })} />
    </div>
  );
}

/**
 * What both of the above subscribe to, so they cannot drift apart.
 *
 * `undecided` is the state `DictStatus` cannot hold — see `useDictStatus`: a
 * probe reports nothing, so while it runs the status is still the `absent` it
 * started in, which is the *ask*, and drawing it before the probe answers
 * flashes a live button at a learner who already has the dictionary.
 */
interface DictSurfaceState {
  status: DictStatus;
  undecided: boolean;
  start: () => void;
}

function useDictSurface(store?: DictStore, opener?: DictOpener): DictSurfaceState {
  const resolvedStore = store ?? getDictStore();
  const resolvedOpener = useMemo(
    () => opener ?? getDictOpener(resolvedStore),
    [opener, resolvedStore],
  );
  const { status, checking } = useDictStatus(resolvedStore, resolvedOpener);
  return {
    status,
    undecided: checking && status.state === 'absent',
    start: () => {
      // The one affordance that downloads. `absent` → "Get it"; `failed` → "Try
      // again", which is the same fetch of the same content-addressed file.
      void resolvedOpener.download().catch(() => undefined);
    },
  };
}

function DictSurface({ surface, source }: { surface: DictSurfaceState; source?: DictSource }) {
  if (surface.undecided) return null;
  return (
    <DictStatusView
      status={surface.status}
      {...(source === undefined ? {} : { source })}
      onStart={surface.start}
    />
  );
}
