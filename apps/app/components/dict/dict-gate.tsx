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
 * lost — `open()` resolves in a microtask and a read-then-subscribe would miss
 * a store that was already warm.
 */
export function useDictStatus(store: DictStore = getDictStore()): DictStatus {
  const [status, setStatus] = useState<DictStatus>(() => store.status);

  useEffect(() => {
    const unsubscribe = store.subscribe(setStatus);
    setStatus(store.status);
    // Idempotent and safe on every mount — the interface promises it, and the
    // implementation shares one in-flight probe across every caller.
    //
    // The rejection is swallowed **here and nowhere else**: `open()` rejects on
    // failure (`SqliteDictStore` does; the HTTP bridge `data.md` D6 replaced did
    // not), and a `void` on a rejecting promise is an unhandled rejection that
    // fails a Playwright run on a page error. There is nothing lost — the
    // failure is already on `status`, with its reason, which is what this
    // component renders.
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
