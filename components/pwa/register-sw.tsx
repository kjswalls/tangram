'use client';

/**
 * Registers `public/sw.js` (PLAN.md §3.6).
 *
 * **Production only, deliberately.** A service worker in `next dev` caches
 * chunks that Turbopack is still rewriting, so the symptom is a dev server that
 * serves yesterday's page and no obvious reason why. `pnpm build && pnpm start`
 * — which is exactly what the e2e webServer runs — is where it registers.
 *
 * Registration failure is swallowed: an unsupported browser, a private window,
 * or a blocked worker is a missing enhancement, not an error the user can act
 * on.
 */

import { useEffect } from 'react';

export const SW_URL = '/sw.js';

export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

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
