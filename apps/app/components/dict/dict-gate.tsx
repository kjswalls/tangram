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
 * so), including that file's `HEAD` probe of the HSK route: the store's
 * `open()` is that probe now, asked once for the whole app instead of once per
 * route mount.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { DictStatusView, type DictSource } from '@/components/dict/dict-status';
import { getDictStore } from '@/lib/dict/browser-store';
import type { DictStatus, DictStore } from '@/lib/dict/store';

/**
 * The store's status, live.
 *
 * Subscribes before reading, so a status that changes between the two is not
 * lost — the open resolves in a microtask and a read-then-subscribe would miss
 * a store that was already warm.
 *
 * **A silent 14 MB download is what the mount now means, and that is an open
 * question rather than a decision.** Until `data.md` D6 this call was
 * `HttpDictStore.open()` — one HSK query against a route, the cheap successor to
 * the old `HEAD` banner probe. D6 pointed the app at the OPFS store, so the same
 * line came to mean *download the artifact*, and the `absent` screen below —
 * the one with the size on it and a start button, which
 * `components/dict/dict-status.tsx` says exists because "a silent 14 MB download
 * on a metered connection is a hostile default" — stopped being reachable on the
 * web: the effect moves the store to `preparing` on the first render.
 *
 * D6 did **not** change it, and the reason is that the repository contains both
 * intentions and resolving them is not a builder's call. `dict-status.tsx` and
 * `tests/e2e/core/dict-states.spec.ts` say `absent` is an explicit ask; D4 built
 * a determinate progress bar *for a 43 MB first load*, which reads as a download
 * that starts on its own; and `tests/e2e/smoke.spec.ts`'s "no gate when the
 * dictionary answers" asserts a first visit shows no gate at all. The `absent`
 * screen may also be aimed at the native first-launch copy (`asset-absent`,
 * `ios.md` register #18), where a start affordance is unambiguous.
 *
 * The machinery to implement the ask exists and is one line:
 * `getDictHandle().openStored()` here instead of `store.open()`, with the
 * button's `onStart` calling `download()`. HANDOFF.md under D6 carries this,
 * and whoever owns the product decision can spend that line.
 */
export function useDictStatus(store: DictStore = getDictStore()): DictStatus {
  const [status, setStatus] = useState<DictStatus>(() => store.status);

  useEffect(() => {
    const unsubscribe = store.subscribe(setStatus);
    setStatus(store.status);
    // The rejection is swallowed **here and nowhere else**: an open rejects on
    // failure (`SqliteDictStore` does; the HTTP bridge D6 replaced did not), and
    // a `void` on a rejecting promise is an unhandled rejection that fails a
    // Playwright run on a page error. Nothing is lost — the failure is already
    // on `status`, with its reason, which is what this component renders.
    void store.open().catch(() => undefined);
    return unsubscribe;
  }, [store]);

  return status;
}

export interface DictGateProps {
  children: ReactNode;
  /** Download on the web; an asset copy on a phone's first launch. */
  source?: DictSource;
  store?: DictStore;
  /** Rendered above the children when ready — nothing, by design. */
  className?: string;
}

export function DictGate({ children, source, store, className }: DictGateProps) {
  const resolved = store ?? getDictStore();
  const status = useDictStatus(resolved);

  if (status.state === 'ready') return <>{children}</>;

  return (
    <div data-testid="dict-gate" data-state={status.state} className={className}>
      <DictStatusView
        status={status}
        {...(source === undefined ? {} : { source })}
        onStart={() => {
          void resolved.open().catch(() => undefined);
        }}
      />
    </div>
  );
}
