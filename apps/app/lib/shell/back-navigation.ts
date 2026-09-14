/**
 * The hardware back button's navigation model (`docs/plans/android.md` A1).
 *
 * **Why this exists at all.** `web.md` §2 assigns the Android hardware back
 * button to `android.md`, and nothing in any sibling plan defines its behaviour:
 * `core.md` C7 builds three tabs and tab state that survives navigation away and
 * back, but it contains no back-button model and no tab history. So A1 writes
 * one, and A1's rule is that it lives in **one** module so there are not two
 * competing navigation owners. This is that module. `core.md` C7 adopts it
 * rather than writing a second one — see `HANDOFF.md`.
 *
 * **Nothing here is Android-specific and nothing here imports Capacitor.** The
 * model is a plain state machine over (tab, depth, most-recently-visited tabs),
 * which is what makes it testable in the container — the only thing this repo
 * can do for a device feature it cannot run. `components/shell/hardware-back-button.tsx`
 * is the thin mount that wires it to `@capacitor/app`'s `backButton` event and
 * to the router; it holds no policy.
 *
 * ## The four rules, verbatim from A1
 *
 * 1. A back press with a sheet, dialog or overlay open closes that and stops.
 * 2. Otherwise, if the current tab's own history stack is deeper than its root,
 *    pop it.
 * 3. Otherwise, if the tab is not the **first** tab, switch to the previously
 *    visited tab, maintaining a most-recently-visited stack of tabs and popping
 *    it — not a fixed left-to-right order, because a learner who went Look up →
 *    Library → Practice expects back to return to Library.
 * 4. At the root of the first tab, or with the tab stack exhausted, **background
 *    the app** rather than finishing the activity, so resuming returns to where
 *    they were mid-session.
 *
 * ## Two things the implementation has to get right that the rules do not say
 *
 * **Rule 3 pops, so the echo must not push.** `handleBack()` returning
 * `switch-tab` is followed, a tick later, by the router reporting a navigation
 * *to* that tab — and if that arrival were treated as an ordinary visit it would
 * push the tab we just left back onto the stack, and back would ping-pong
 * between two tabs forever instead of walking out. So a `switch-tab` decision
 * arms `pendingBackTo`, and the arrival that matches it is consumed rather than
 * recorded. This is the only piece of hidden state in the model and it is
 * asserted directly in the tests.
 *
 * **`canGoBack` on the event payload is not the answer to rule 2.**
 * `@capacitor/app`'s `BackButtonListenerEvent` carries the WebView's own
 * `canGoBack`, which is true whenever *any* previous entry exists — including
 * one in a different tab. Rule 2 is about the current tab's stack, so the model
 * keeps its own per-tab depth and the payload is ignored.
 *
 * **Listening disables the platform default.** `@capacitor/app`'s own docs:
 * *"Listening for this event will disable the default back button behaviour, so
 * you might want to call `window.history.back()` manually. If you want to close
 * the app, call `App.exitApp()`."* Once the listener is attached every press is
 * ours, including the one at the end — which is why rule 4 is `minimizeApp()`
 * and not "do nothing". `exitApp()` is deliberately never called: it finishes
 * the activity, and a learner who backs out of a practice session and returns
 * should find the session, not a cold start.
 */

/** What a back press resolves to. The mount executes these and decides nothing. */
export type BackAction =
  | { type: 'close-overlay' }
  | { type: 'pop' }
  | { type: 'switch-tab'; to: string }
  | { type: 'background' };

/**
 * React Router's `useNavigationType()` values. `PUSH` and `REPLACE` are the
 * router's own; `POP` is a history traversal, which is both the browser back
 * button and our own rule-2 `navigate(-1)`.
 */
export type NavigationKind = 'PUSH' | 'POP' | 'REPLACE';

export interface BackDecisionContext {
  /** Is a sheet, dialog or other overlay open? See `overlayRegistry`. */
  overlayOpen: boolean;
}

/** Strip a trailing slash so `/lookup/` and `/lookup` are the same tab root. */
function normalise(path: string): string {
  if (!path.startsWith('/')) path = `/${path}`;
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export interface BackNavigationSnapshot {
  current: string | null;
  /** Depth of the current tab's stack beyond its root. */
  depth: number;
  /** Most-recently-visited tabs, oldest first, current excluded. */
  mru: readonly string[];
}

export interface BackNavigation {
  /** Record an arrival. Called for every router location change. */
  visit(path: string, kind?: NavigationKind): void;
  /** Decide and apply a back press. */
  handleBack(context: BackDecisionContext): BackAction;
  /** Read-only view, for tests and for `HANDOFF.md`'s device checklist. */
  snapshot(): BackNavigationSnapshot;
}

/**
 * `tabs` is the ordered list of tab root paths. Its **first** entry is rule 3's
 * and rule 4's "first tab" — the one the app backs out of rather than through.
 *
 * At A1 that list is `components/shell/nav.ts`'s seven routes, because that is
 * the shell `web.md` W1 produced and A1 deliberately does not gate on C7. After
 * C7 it is three, and the first entry becomes Look up. Nothing in this module
 * knows which; the caller supplies the list.
 */
export function createBackNavigation(tabs: readonly string[]): BackNavigation {
  const roots = tabs.map(normalise);
  if (roots.length === 0) throw new Error('createBackNavigation needs at least one tab');

  /** Per-tab path stack; index 0 is always the tab root. */
  const stacks = new Map<string, string[]>();
  let mru: string[] = [];
  let current: string | null = null;
  let pendingBackTo: string | null = null;

  /**
   * Which tab a path belongs to: the longest root that is a prefix of it.
   *
   * Longest wins so that a `/` tab does not swallow `/lookup`. A path under no
   * tab at all (a 404, a detail route the tab list does not cover) is attributed
   * to the tab the learner is already in, which is what keeps rule 2 working for
   * routes nobody enumerated.
   */
  function tabOf(path: string): string | null {
    let best: string | null = null;
    for (const root of roots) {
      if (path === root || (root === '/' ? path.startsWith('/') : path.startsWith(`${root}/`))) {
        if (best === null || root.length > best.length) best = root;
      }
    }
    return best ?? current;
  }

  function stackOf(tab: string): string[] {
    let stack = stacks.get(tab);
    if (!stack) {
      stack = [tab];
      stacks.set(tab, stack);
    }
    return stack;
  }

  function touchMru(leaving: string | null, arriving: string) {
    if (leaving === null || leaving === arriving) return;
    mru = mru.filter((tab) => tab !== leaving);
    mru.push(leaving);
  }

  return {
    visit(rawPath: string, kind: NavigationKind = 'PUSH') {
      const path = normalise(rawPath);
      const tab = tabOf(path);
      if (tab === null) return;
      const stack = stackOf(tab);

      if (path === tab) {
        // Arriving at a tab root always resets that tab to its root, whichever
        // way the arrival happened. This is what makes "tap the tab you are on"
        // behave like every phone app: it goes home within the tab.
        stack.length = 0;
        stack.push(tab);
      } else if (kind === 'POP') {
        // Walk back to the entry if we have it; otherwise this is a deep link
        // into a tab with no recorded history, so the tab root plus it is the
        // honest stack.
        const at = stack.lastIndexOf(path);
        if (at >= 0) stack.length = at + 1;
        else stack.splice(0, stack.length, tab, path);
      } else if (kind === 'REPLACE') {
        if (stack.length === 1) stack.push(path);
        else stack[stack.length - 1] = path;
      } else if (stack[stack.length - 1] !== path) {
        stack.push(path);
      }

      if (pendingBackTo !== null && pendingBackTo === tab) {
        // The echo of our own rule-3 switch: consume it, do not re-push the tab
        // we just walked out of. See the header.
        pendingBackTo = null;
        current = tab;
        return;
      }
      pendingBackTo = null;
      touchMru(current, tab);
      current = tab;
    },

    handleBack({ overlayOpen }: BackDecisionContext): BackAction {
      if (overlayOpen) return { type: 'close-overlay' };

      const tab = current ?? roots[0];
      if (stackOf(tab).length > 1) return { type: 'pop' };

      const previous = mru[mru.length - 1];
      if (tab !== roots[0] && previous !== undefined) {
        mru = mru.slice(0, -1);
        pendingBackTo = previous;
        return { type: 'switch-tab', to: previous };
      }

      return { type: 'background' };
    },

    snapshot() {
      const tab = current;
      return {
        current: tab,
        depth: tab === null ? 0 : stackOf(tab).length - 1,
        mru: [...mru],
      };
    },
  };
}

/**
 * The overlay stack rule 1 reads.
 *
 * A LIFO registry rather than a boolean, because two overlays can be open at
 * once (a sheet with a confirm dialog over it) and back must close the top one
 * only. Whatever primitive `core.md` C1 ships as the sheet registers here on
 * open and unregisters on close; until it does, `hasOpenOverlay()` is false and
 * rule 1 is inert rather than wrong.
 *
 * Module state, deliberately: there is one window, one back button and one
 * top-most overlay, and threading a context through every sheet to say so would
 * be ceremony. `resetOverlays()` exists for tests.
 */
const overlayClosers: Array<() => void> = [];

/** Register an open overlay. Returns the unregister function. */
export function registerOverlay(close: () => void): () => void {
  overlayClosers.push(close);
  return () => {
    const at = overlayClosers.lastIndexOf(close);
    if (at >= 0) overlayClosers.splice(at, 1);
  };
}

export function hasOpenOverlay(): boolean {
  return overlayClosers.length > 0;
}

/** Close the top-most overlay. Returns false when there was none. */
export function closeTopOverlay(): boolean {
  const close = overlayClosers.pop();
  if (!close) return false;
  close();
  return true;
}

/** Tests only. */
export function resetOverlays(): void {
  overlayClosers.length = 0;
}
