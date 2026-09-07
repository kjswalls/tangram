'use client';

/**
 * Registers `public/sw.js` (PLAN.md §3.6).
 *
 * **Production only, deliberately.** A service worker in `next dev` caches
 * chunks that Turbopack is still rewriting, so the symptom is a dev server that
 * serves yesterday's page and no obvious reason why. `pnpm build && pnpm start`
 * — which is exactly what the e2e webServer runs — is where it registers.
 *
 * Not registering is not enough, though: registrations are **per origin** and
 * outlive the server that installed them, and `pnpm start -p 3000` (the e2e
 * webServer) and `next dev` (port 3000) are the same origin. A worker installed
 * by a production run keeps answering under `next dev`, which is the exact
 * symptom the gate exists to prevent. So the dev branch actively tears down any
 * worker and cache it finds instead of returning quietly.
 *
 * Registration failure is swallowed: an unsupported browser, a private window,
 * or a blocked worker is a missing enhancement, not an error the user can act
 * on.
 */

import { useEffect } from 'react';

export const SW_URL = '/sw.js';

export function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    if (process.env.NODE_ENV !== 'production') {
      // Undo a production worker that is still controlling this origin.
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
        .catch(() => {});
      void globalThis.caches
        ?.keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => {});
      return;
    }

    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      void navigator.serviceWorker.register(SW_URL, { scope: '/' }).catch(() => {
        /* no worker, no offline shell; the app is unaffected */
      });
    };

    // After load, so registration never competes with the first paint.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });

    return () => {
      cancelled = true;
      window.removeEventListener('load', register);
    };
  }, []);

  return null;
}
