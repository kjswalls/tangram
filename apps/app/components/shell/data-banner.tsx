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
    // HEAD, not GET: Next answers it from the same route handler with the same
    // status, and the banner only ever reads the status — a GET would pull the
    // whole 160 KB band-1 payload on every cold load of every route.
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
