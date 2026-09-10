'use client';

import { useEffect, useState } from 'react';

/**
 * Missing dictionary data is a banner, not a crash (PLAN.md §3.2). One probe of
 * a cheap dictionary route on mount: a 503 means `data/` was never generated.
 * Anything else — including the 404 that stands in before the route exists — is
 * silence, because a banner about a route that has not shipped teaches nothing.
 */
export function DataBanner() {
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // HEAD, not GET: the route exports its own HEAD (app/api/dict/hsk/route.ts)
    // which answers with the same status and no body — the banner only ever reads
    // the status, and a GET would pull the whole 160 KB band-1 payload every time
    // the shell mounts, which is every cold page load of the app.
    //
    // This one line is also the trigger for the dictionary warm-up: that HEAD is
    // what schedules `warmDictionary()` (lib/dict/warm.ts) through `after()`, and
    // it is the only caller that does. Switching it to GET, or dropping it because
    // the banner "usually shows nothing", puts ~1.5 s back on the first lookup of
    // every session with every test still green — so the method is pinned by
    // tests/unit/shell/data-banner.test.tsx.
    fetch('/api/dict/hsk?band=1', { method: 'HEAD' })
      .then((response) => {
        if (!cancelled) setMissing(response.status === 503);
      })
      .catch(() => {
        /* offline or route not up yet: not a data problem we can diagnose */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!missing) return null;

  return (
    <div role="status" data-testid="data-banner" className="border-b border-border bg-warning-soft">
      <p className="mx-auto w-full max-w-3xl px-4 py-2 text-sm text-warning">
        Dictionary data is missing. Run <code className="font-mono">pnpm data</code> to build it.
      </p>
    </div>
  );
}
