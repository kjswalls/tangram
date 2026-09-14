/**
 * Wires Android's hardware back button to the model in
 * `lib/shell/back-navigation.ts` (`docs/plans/android.md` A1).
 *
 * **This file holds no policy.** The four rules, the per-tab depth and the
 * most-recently-visited tab stack are all in the model, which is a plain state
 * machine and is unit-tested in the container. What is here is the three things
 * only a mounted component can do: feed the model every router location, attach
 * the native listener, and execute the action the model returns.
 *
 * **`@capacitor/app` is imported dynamically, inside the effect, behind
 * `isAndroid()`.** A static import would pull `@capacitor/core` into the web
 * bundle — which is not a correctness problem (`lib/platform/native.ts` tests
 * `isNativePlatform()`, not the global's presence, exactly so that this cannot
 * switch the web PWA's service worker off) but it is bytes shipped to every
 * browser for a button no browser has. Vite splits the dynamic import into its
 * own chunk that the web build never fetches. `HANDOFF.md` records the bundle
 * measurement.
 *
 * The listener is Android-only because the event is: `@capacitor/app` documents
 * `backButton` and `minimizeApp()` as Android-only. iOS mounts this and does
 * nothing, which is cheaper than a second component.
 */
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router';

import { NAV_ITEMS } from '@/components/shell/nav';
import { isAndroid } from '@/lib/platform/native';
import {
  closeTopOverlay,
  createBackNavigation,
  hasOpenOverlay,
  type BackNavigation,
  type NavigationKind,
} from '@/lib/shell/back-navigation';

/**
 * The tab roots, in order; the first is the one the app backs **out of**.
 *
 * At A1 this is `components/shell/nav.ts`'s seven routes, because `web.md` W1
 * ported the existing app rather than restructuring it and A1 deliberately does
 * not gate on `core.md` C7 (`wave-zero.md` §4). **C7 re-baselines it** — to
 * three tabs, with Look up first — by passing its own list, which is why this is
 * a prop with a default rather than a constant read inside the model.
 */
const DEFAULT_TABS = NAV_ITEMS.map((item) => item.href);

export interface HardwareBackButtonProps {
  /** Tab roots in order. Defaults to the shell's current nav. */
  tabs?: readonly string[];
}

export function HardwareBackButton({ tabs = DEFAULT_TABS }: HardwareBackButtonProps = {}) {
  const location = useLocation();
  const navigationType = useNavigationType() as NavigationKind;
  const navigate = useNavigate();

  const modelRef = useRef<BackNavigation | null>(null);
  if (modelRef.current === null) modelRef.current = createBackNavigation(tabs);
  const model = modelRef.current;

  // Every arrival, including the first render's. `location.key` changes on a
  // re-visit to the same path, which is a real navigation and a real depth
  // change, so it is in the dependency list beside the pathname.
  useEffect(() => {
    model.visit(location.pathname, navigationType);
  }, [model, location.key, location.pathname, navigationType]);

  useEffect(() => {
    if (!isAndroid()) return;

    let cancelled = false;
    let handle: { remove: () => Promise<void> } | null = null;

    void import('@capacitor/app')
      .then(({ App }) =>
        App.addListener('backButton', () => {
          // The event's own `canGoBack` is the WebView's history, which crosses
          // tabs; rule 2 is about this tab's stack. The model is the authority.
          const action = model.handleBack({ overlayOpen: hasOpenOverlay() });
          switch (action.type) {
            case 'close-overlay':
              closeTopOverlay();
              return;
            case 'pop':
              navigate(-1);
              return;
            case 'switch-tab':
              navigate(action.to);
              return;
            case 'background':
              // Not `exitApp()`: backgrounding keeps the session, finishing the
              // activity throws it away. See the model's header.
              void App.minimizeApp();
              return;
          }
        }),
      )
      .then((listener) => {
        if (cancelled) void listener.remove();
        else handle = listener;
      })
      .catch(() => {
        // No plugin, no hardware button. The platform default stays in place,
        // which is a worse back button rather than a broken app.
      });

    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [model, navigate]);

  return null;
}
