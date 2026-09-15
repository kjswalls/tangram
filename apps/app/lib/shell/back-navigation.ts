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
 * model is a plain state machine over (the history, the current tab, the
 * most-recently-visited tabs),
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
 * one in a different tab. Rule 2 is about the current tab, so the model keeps its
 * own record of the history and the payload is ignored.
 *
 * **Rule 2 has to promise only what `navigate(-1)` can deliver.** The mount's
 * only way to pop is a history traversal, and history is global. So "the current
 * tab's own history stack is deeper than its root" is answered as *the entry
 * below this one is in this tab* — which is the same claim, made against the
 * thing that will actually happen. An earlier version of this model kept a stack
 * per tab, which could report depth 1 for `/lists/abc` entered straight from
 * `/stats` and then leave the tab on a press that promised not to. The component
 * test caught it; the model could not see it, because the bug was in the
 * relationship between the model and the router rather than inside either.
 *
 * **Four more, each found by driving this rather than by reading it**, and each
 * stated at the line that handles it: `'/'` is a tab root and not a namespace
 * (`tabOf`); a query string is not a history entry (`normalise`); the first
 * arrival is not poppable however the router labels it (`visit`); and a tab the
 * learner has just arrived at must leave the most-recently-visited stack, or
 * backing out revisits it (`touchMru`). Every one of them is a wrong answer on a
 * phone and a green test suite otherwise, which is why they are in
 * `tests/unit/shell/back-navigation.test.ts` under their own heading.
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

/**
 * Reduce a location to the thing tabs and depth are about: its path.
 *
 * A query string and a hash are dropped — `/lookup?q=你` is the Look up tab at
 * its root, not a page below it, and treating it otherwise would make every
 * keystroke in the search box look like a history entry to pop. React Router's
 * `location.pathname` never carries either, so the mount cannot hit this; the
 * function is public and a caller with a full URL can.
 *
 * A trailing slash goes too, so `/lookup/` and `/lookup` are one tab root.
 */
function normalise(path: string): string {
  const bare = path.split(/[?#]/, 1)[0];
  const withSlash = bare.startsWith('/') ? bare : `/${bare}`;
  const trimmed = withSlash.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export interface BackNavigationSnapshot {
  current: string | null;
  /**
   * How many entries directly below this one are in the same tab. This is the
   * quantity rule 2 asks about, counted over the real history rather than over a
   * per-tab stack — see the header.
   */
  depth: number;
  /** Most-recently-visited tabs, oldest first, current excluded. */
  mru: readonly string[];
  /**
   * How many entries this session has recorded below the current one — what
   * `navigate(-1)` has to work with. Zero on a cold start, however deep the
   * route it started on.
   */
  historyDepth: number;
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

  /**
   * The history stack as this session observed it, oldest first.
   *
   * **One list, not a stack per tab**, and that is the correction the component
   * test forced. A per-tab stack can say "this tab has a page below its root"
   * while the entry `navigate(-1)` would actually land on belongs to a different
   * tab — enter `/lists/abc` straight from `/stats` and the tab's depth is 1 but
   * the entry underneath is `/stats`. Rule 2 then promises to stay in the tab and
   * leaves it. Keeping the real order makes the question answerable exactly:
   * rule 2 fires only when the entry below is in the same tab, which is what
   * makes `navigate(-1)` safe.
   */
  /**
   * **Each entry carries the tab it was recorded under, not just its path.**
   * `tabOf` falls back to "the tab the learner is in" for a path under no root,
   * and that answer is only true at the moment of the arrival. Resolving it
   * again later reads the *current* tab, so `/entry/x` opened from Look up would
   * be re-read as belonging to whichever tab the learner is in when they press
   * back — and rule 2 would offer a pop that leaves the tab it promised to stay
   * in. Resolve once, at record time.
   */
  let entries: Array<{ path: string; tab: string }> = [];
  let mru: string[] = [];
  let current: string | null = null;
  let pendingBackTo: string | null = null;

  /**
   * Which tab a path belongs to: the longest root that is a prefix of it.
   *
   * Longest wins, so `/lists` claims `/lists/abc` rather than a shorter root
   * doing it. Two cases are worth stating because getting either wrong is
   * invisible until someone presses back:
   *
   * - **`'/'` matches only itself.** It is a tab root, not a namespace. As a
   *   prefix it matches every path in the app, so `/entry/你好` would be filed
   *   under the Today tab — and a learner who opened that entry from Look up
   *   would find back taking them to Today. Every shell in this plan has a `/`
   *   tab at A1, so this is the common case, not the exotic one.
   * - **A path under no root is filed under the tab the learner is in.** A 404,
   *   or a detail route the tab list does not enumerate, is somewhere they
   *   navigated *from* a tab; rule 2 should pop it, not leave the tab.
   */
  function tabOf(path: string): string | null {
    let best: string | null = null;
    for (const root of roots) {
      const matches = root === '/' ? path === '/' : path === root || path.startsWith(`${root}/`);
      if (matches && (best === null || root.length > best.length)) best = root;
    }
    return best ?? current;
  }

  /**
   * The stack is "tabs I could go back to", so the tab being arrived at leaves
   * it and the tab being left goes on top.
   *
   * Removing the arriving tab is not tidiness. Look up → Review → Look up, then
   * back: without it the stack still holds Look up from the first visit, so the
   * second press returns to the tab the learner is standing in and the walk out
   * takes one press more than it should, revisiting a tab on the way.
   */
  function touchMru(leaving: string | null, arriving: string) {
    mru = mru.filter((tab) => tab !== arriving);
    if (leaving === null || leaving === arriving) return;
    mru = mru.filter((tab) => tab !== leaving);
    mru.push(leaving);
  }

  return {
    visit(rawPath: string, kind: NavigationKind = 'PUSH') {
      const path = normalise(rawPath);
      const tab = tabOf(path);
      if (tab === null) return;

      const entry = { path, tab };
      const top = () => entries[entries.length - 1];

      if (entries.length === 0) {
        // The first arrival is the entry the app opened on. It is not poppable,
        // whatever the router calls it: a cold start reports POP.
        entries = [entry];
      } else if (kind === 'POP') {
        if (entries.length > 1) entries.pop();
        // Resync if the router went somewhere this model did not record — a
        // multi-entry traversal, or a restore. The observed location always wins.
        if (top().path !== path) entries = [entry];
      } else if (kind === 'REPLACE') {
        // A replace onto the entry below it collapses rather than duplicating —
        // otherwise rule 2 offers a pop that lands on the same page.
        if (entries.length > 1 && entries[entries.length - 2].path === path) entries.pop();
        else entries[entries.length - 1] = entry;
      } else if (top().path !== path) {
        // A re-render that re-reports the same location is not a navigation.
        entries.push(entry);
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

      // Rule 2, stated as the thing `navigate(-1)` can actually deliver: there
      // is an entry below, and it is in this tab. If it is in another tab this
      // is not "the current tab's own history stack", and rule 3 decides where
      // to go instead.
      const below = entries.length > 1 ? entries[entries.length - 2] : undefined;
      if (below !== undefined && below.tab === tab) return { type: 'pop' };

      // A second press before the router has reported the first switch must
      // re-issue it, not decide again. `handleBack` mutates — it pops the
      // most-recently-visited stack — and a phone will happily deliver two
      // presses inside one frame, which would pop two tabs for one arrival and
      // background the app a press early, skipping a tab on the way out.
      if (pendingBackTo !== null) return { type: 'switch-tab', to: pendingBackTo };

      const previous = mru[mru.length - 1];
      if (tab !== roots[0] && previous !== undefined) {
        mru = mru.slice(0, -1);
        pendingBackTo = previous;
        return { type: 'switch-tab', to: previous };
      }

      return { type: 'background' };
    },

    snapshot() {
      let depth = 0;
      while (entries.length - 2 - depth >= 0 && entries[entries.length - 2 - depth].tab === current) {
        depth += 1;
      }
      return {
        current,
        depth,
        mru: [...mru],
        historyDepth: Math.max(0, entries.length - 1),
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
