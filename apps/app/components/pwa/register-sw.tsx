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
 *
 * **It also does not register inside a native WebView** (docs/plans/web.md W1,
 * docs/plans/wave-zero.md §10 ruling 12). There the assets are already local and
 * already versioned by the app build, so a worker adds nothing and can serve a
 * previous build's shell after an app update — and whether one even registers
 * under a local scheme is established by no audit.
 *
 * **W1 specifies the test as "production AND an `https:` origin". That is wrong
 * and this does not implement it.** Two reasons, and the first is load-bearing:
 *
 *  1. `http://localhost` is a **secure context** by specification, and service
 *     workers register there. `pnpm preview` — which is what the e2e suite runs
 *     against, in production mode — serves exactly that, so an `https:`-only
 *     test silently stops the worker registering in every end-to-end run.
 *     `tests/e2e/p6/pwa.spec.ts` and `tests/e2e/c/sw-version.spec.ts` both wait
 *     on `navigator.serviceWorker.ready` and both hang. W1 lists those two specs
 *     as surviving the phase unchanged, so the plan did not notice.
 *  2. It does not achieve what it is for. Capacitor serves `capacitor://localhost`
 *     on iOS — which an `https:` test does exclude — but **`http://localhost` on
 *     Android**, which is origin-identical to the preview server. No test on the
 *     URL alone can tell an Android WebView from a local production server.
 *
 * What does tell them apart is the bridge: Capacitor injects a `Capacitor`
 * global into the WebView before any app code runs, and nothing does that on the
 * web. So the test is **production AND a secure context AND no native bridge**,
 * with the two custom schemes rejected outright as well. That registers on
 * `https://` and on the preview server, and refuses both native WebViews.
 *
 * The predicate is still written inline and dependency-free on purpose:
 * `lib/platform/native.ts` is `ios.md` I0's module to create, and I0 re-points
 * this one call site at it without changing the observable behaviour.
 */

import { useEffect } from 'react';

export const SW_URL = '/sw.js';

export interface RegisterEnvironment {
  /** `import.meta.env.PROD` — false under `vite dev` and under vitest. */
  isProduction: boolean;
  /** `window.location.protocol`, e.g. `https:`, `http:`, `capacitor:`. */
  protocol: string;
  /** `window.location.hostname`. */
  hostname: string;
  /** `window.isSecureContext` — true for https and for `http://localhost`. */
  isSecureContext: boolean;
  /**
   * Is this actually running on a device, per the Capacitor bridge?
   *
   * Not "does a `Capacitor` global exist". `@capacitor/core` assigns that global
   * the moment it is *imported*, and there is one build for all three platforms
   * — so as soon as `ios.md` I0 adds the dependency and anything imports it, the
   * global exists in the web bundle too and a bare presence test would switch
   * the web PWA's worker off. `isNativePlatform()` is the question that means
   * what it says, and the presence test is only the fallback for a bridge too
   * old to answer it.
   */
  isNativePlatform: boolean;
}

/** Custom schemes a native shell serves from. Never a web origin. */
const NATIVE_SCHEMES = new Set(['capacitor:', 'tauri:', 'file:', 'ionic:']);

/**
 * Hosts a native shell serves from over plain http, where the scheme cannot
 * tell you anything. Tauri 2 uses `tauri://localhost` on macOS, Linux and iOS
 * but `http://tauri.localhost` on Windows and Android — which is a secure
 * context (the URL spec treats any host ending in `.localhost` as potentially
 * trustworthy) and injects no Capacitor global, so neither of the other two
 * tests catches it.
 */
const NATIVE_HOSTS = new Set(['tauri.localhost']);

/** Exported for the unit test: the branch has no other observable output. */
export function shouldRegister(env: RegisterEnvironment): boolean {
  if (!env.isProduction) return false;
  if (env.isNativePlatform) return false;
  if (NATIVE_SCHEMES.has(env.protocol)) return false;
  if (NATIVE_HOSTS.has(env.hostname)) return false;
  // Not `protocol === 'https:'`: `http://localhost` is a secure context and is
  // what `pnpm preview` and the whole e2e suite serve. See the header.
  return env.isSecureContext;
}

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
}

function readEnvironment(): RegisterEnvironment {
  const bridge = (window as Window & { Capacitor?: CapacitorBridge }).Capacitor;
  return {
    isProduction: import.meta.env.PROD,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    isSecureContext: window.isSecureContext,
    isNativePlatform:
      typeof bridge?.isNativePlatform === 'function' ? bridge.isNativePlatform() : bridge !== undefined,
  };
}

export function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    if (!shouldRegister(readEnvironment())) {
      // Dev only: undo a production worker still controlling this origin.
      // Inside a native WebView there is nothing to undo and the caches belong
      // to the app, so tear down only where the problem exists.
      if (!import.meta.env.PROD) {
        void navigator.serviceWorker
          .getRegistrations()
          .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
          .catch(() => {});
        void globalThis.caches
          ?.keys()
          .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
          .catch(() => {});
      }
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
