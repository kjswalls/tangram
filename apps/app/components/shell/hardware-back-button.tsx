/**
 * Wires Android's hardware back button to the model in
 * `lib/shell/back-navigation.ts` (`docs/plans/android.md` A1).
 *
 * **This file holds no policy.** The four rules, the recorded history and the
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

import { TABS, TAB_PATHS } from '@/components/shell/nav';
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
 * At A1 this was `components/shell/nav.ts`'s seven routes, because `web.md` W1
 * ported the existing app rather than restructuring it and A1 deliberately does
 * not gate on `core.md` C7 (`wave-zero.md` §4). **C7 has re-baselined it**: it
 * is the three tabs now, Look up first, read from the same `TABS` the bar
 * renders so the button and the bar cannot disagree about what a tab root is.
 * It stays a prop with a default because A1's tests drive it directly.
 */
const DEFAULT_TABS = TABS.map((tab) => tab.path);

/**
 * Sub-paths that belong to a tab without being its root.
 *
 * `/read` is a page inside **Look up** — it has a path so a text can be
 * bookmarked and returned to — and `'/'` matches only itself in the model's
 * prefix rule, so without this `/read` belongs to no tab. A cold start there
 * was then never recorded at all, and the first back press after moving to
 * another tab minimised the app instead of returning to the text. Derived from
 * `TAB_PATHS` rather than typed out, so a phase that adds a sub-path to a tab
 * has one place to declare it.
 */
const DEFAULT_SUB_PATHS: Readonly<Record<string, string>> = {
  [TAB_PATHS.texts]: TAB_PATHS.lookup,
};

/**
 * The plugin module, fetched once for the life of the page.
 *
 * The effect can run more than once — React StrictMode mounts, unmounts and
 * remounts every effect in development, and the tab list can change — and each
 * run needs the plugin. A bare `import()` per run relies on the module registry
 * to dedupe, which a real browser does and a test runner's module mocker does
 * not: under vitest a second concurrent dynamic import of a mocked module never
 * settles, so the surviving listener is never attached and the component looks
 * broken. Memoising the promise is both the honest description of what is wanted
 * — one fetch — and the thing that makes the StrictMode case observable.
 */
let appPlugin: Promise<typeof import('@capacitor/app')> | null = null;

function loadAppPlugin(): Promise<typeof import('@capacitor/app')> {
  appPlugin ??= import('@capacitor/app');
  return appPlugin;
}

export interface HardwareBackButtonProps {
  /** Tab roots in order. Defaults to the shell's current nav. */
  tabs?: readonly string[];
  /** Paths that belong to a tab without being its root. See `DEFAULT_SUB_PATHS`. */
  belongsTo?: Readonly<Record<string, string>>;
}

export function HardwareBackButton({
  tabs = DEFAULT_TABS,
  belongsTo = DEFAULT_SUB_PATHS,
}: HardwareBackButtonProps = {}) {
  const location = useLocation();
  const navigationType = useNavigationType() as NavigationKind;
  const navigate = useNavigate();

  /**
   * One model, rebuilt only if the tab list itself changes.
   *
   * A `useRef` initialiser alone would pin the list captured on the first
   * render, which is wrong for the one case that is actually coming: `core.md`
   * C7 re-baselines seven routes to three, and a shell that swaps the list at
   * runtime would keep answering against the old one — the learner presses back
   * at the root of what is now the first tab and the app switches tabs instead
   * of backgrounding. Keyed on the contents, not the array identity, so an
   * inline literal does not rebuild it on every render. Rebuilding does discard
   * the recorded history, which is right: the tabs it was recorded against are
   * gone.
   *
   * `JSON.stringify` rather than a join on a separator, because a tab root is a
   * URL path and there is no character it certainly cannot contain. The first
   * version reached for a NUL escape inside a `join()` — which the editor wrote
   * as a *literal* NUL byte into the source, so git stopped treating the file as
   * text and reported the whole component as `Bin 4564 -> 6316 bytes` in the
   * diff. A separator that has to be escaped is a separator worth not having.
   */
  const key = JSON.stringify([[...tabs], belongsTo]);
  const modelRef = useRef<{ key: string; model: BackNavigation } | null>(null);
  if (modelRef.current === null || modelRef.current.key !== key) {
    modelRef.current = { key, model: createBackNavigation(tabs, { belongsTo }) };
  }
  const model = modelRef.current.model;

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

    void loadAppPlugin()
      .then(({ App }) =>
        App.addListener('backButton', () => {
          // The event's own `canGoBack` is the WebView's history, which is true
          // whenever any entry exists, including one in another tab. Rule 2 asks
          // whether the entry *below this one* is in this tab. The model knows.
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
