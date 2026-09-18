/**
 * Install: capturing the prompt, and knowing when not to offer one
 * (docs/plans/web.md W5).
 *
 * Installation is a **storage** decision before it is a convenience one
 * (`docs/STACK.md` §2.8): Chromium grants `persist()` silently to an installed
 * origin and skips persisted origins during LRU eviction, and WebKit exempts a
 * Home-Screen or Dock web app from the seven-day ITP cap. A non-installed Safari
 * tab is the dangerous case, and it is the default case for anyone who follows
 * a link.
 *
 * Three engines, three different truths, and the branch is the whole module:
 *
 * - **Chromium** fires `beforeinstallprompt` when it decides the site is
 *   installable. The event must be `preventDefault()`ed and kept, because it can
 *   only be `prompt()`ed once and only from a user gesture. It fires *before*
 *   React mounts on a warm load, so the capture is started from `src/main.tsx`
 *   rather than from a component.
 * - **WebKit** never fires it and has no programmatic install at all. Safari
 *   needs instructions ("Share → Add to Home Screen" / "Add to Dock"), not a
 *   button that cannot work.
 * - **Firefox** has no desktop install. There is nothing honest to offer, so
 *   nothing is offered.
 *
 * And a fourth case that is not an engine: **already installed**, which is
 * `display-mode: standalone` (plus `navigator.standalone` on iOS, which predates
 * the media query). Offering to install an installed app is how a learner learns
 * to ignore the thing that keeps their cards.
 *
 * No React here. The store is plain and subscribable; `components/pwa/**` is the
 * only thing that renders it, and `tests/unit/pwa/install.test.ts` drives it
 * with fake events rather than a browser.
 */

import { isNativePlatform } from '@/lib/platform/native';

/**
 * Chromium's install event. Not in `lib.dom.d.ts` — it is not in any
 * specification, which is also why nothing else may assume it exists.
 */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** Which engine's install story applies. Sniffed, because nothing else tells you. */
export type InstallEngine = 'chromium' | 'webkit' | 'firefox' | 'unknown';

/** What the UI should put on screen. */
export type InstallAffordance =
  /** Already an app — installed PWA, or a Capacitor shell. */
  | 'installed'
  /** A captured event is waiting; a button can install it here and now. */
  | 'prompt'
  /** This engine installs by hand. Say how. */
  | 'instructions'
  /** Nothing honest to offer: no event yet, or an engine with no install. */
  | 'none';

export interface InstallState {
  affordance: InstallAffordance;
  engine: InstallEngine;
  /** Running in a standalone window (or a native shell). */
  standalone: boolean;
}

/**
 * Engine sniffing, and it is a sniff — there is no feature to test for "will
 * this browser ever fire `beforeinstallprompt`". `'onbeforeinstallprompt' in
 * window` comes close and is used for the affordance below, but it cannot tell
 * Safari (no install API, but installable by hand) from Firefox (no install at
 * all), and those two need different copy.
 *
 * Order matters: every Chromium browser on iOS carries "CriOS"/"FxiOS" *and*
 * "Safari", and Edge and Chrome both carry "Safari" everywhere.
 */
export function detectEngine(userAgent: string): InstallEngine {
  if (/firefox|fxios/i.test(userAgent)) return 'firefox';
  if (/edg\/|edgios|chrome|crios|chromium|android/i.test(userAgent)) return 'chromium';
  if (/safari|iphone|ipad|ipod|macintosh/i.test(userAgent)) return 'webkit';
  return 'unknown';
}

/** Is this document being shown as an installed app rather than in a tab? */
export function isStandalone(win: Window = window): boolean {
  // A native shell is "installed" in every sense a learner cares about, and it
  // is the one case where none of the checks below is true.
  if (isNativePlatform()) return true;
  // iOS Safari shipped this years before it supported the media query, and it
  // is still the only signal a Home-Screen web app gives on older iOS.
  if ((win.navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  if (typeof win.matchMedia !== 'function') return false;
  return DISPLAY_MODES.some((mode) => win.matchMedia(`(display-mode: ${mode})`).matches);
}

/**
 * The display modes that mean "not a browser tab". `browser` is the only one
 * that is a tab; the manifest asks for `standalone`, but a learner who installs
 * on desktop Chromium with window-controls-overlay, or whose browser downgrades
 * to `minimal-ui`, is just as installed.
 */
const DISPLAY_MODES = ['standalone', 'window-controls-overlay', 'minimal-ui', 'fullscreen'] as const;

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
let teardown: (() => void) | null = null;

/**
 * The window the capture was started on.
 *
 * A module-level variable rather than a default parameter on `compute()`,
 * because the two are not the same thing: `startInstallCapture(win)` listens on
 * `win`, so everything the store publishes has to be read from `win` too. A
 * default that reached for the ambient `window` would listen to one document and
 * describe another — which is exactly what the unit suite (a fake window inside
 * jsdom) does, and it would be just as wrong inside an `<iframe>`.
 */
let active: Window | undefined = typeof window === 'undefined' ? undefined : window;

function compute(win: Window | undefined = active): InstallState {
  const engine = win ? detectEngine(win.navigator.userAgent) : 'unknown';
  const standalone = installed || (win ? isStandalone(win) : false);
  if (standalone) return { affordance: 'installed', engine, standalone };
  if (deferred) return { affordance: 'prompt', engine, standalone };
  // The instructions branch is for an engine that can install but will never
  // hand us an event. Asking the window rather than the sniff is what keeps a
  // future Chromium that drops the event out of the "press this button" path.
  const fires = win ? 'onbeforeinstallprompt' in win : false;
  if (!fires && engine === 'webkit') return { affordance: 'instructions', engine, standalone };
  return { affordance: 'none', engine, standalone };
}

let snapshot: InstallState = compute();

function refresh(): void {
  const next = compute();
  const same =
    next.affordance === snapshot.affordance &&
    next.engine === snapshot.engine &&
    next.standalone === snapshot.standalone;
  // `useSyncExternalStore` compares snapshots by identity and re-renders
  // forever if `getSnapshot` builds a new object every call, so the identity
  // only changes when a field does.
  if (same) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Start listening. Called from `src/main.tsx` **before the first render**,
 * because Chromium fires `beforeinstallprompt` during page load and an event
 * that arrives before the listener does is an install button that never appears.
 *
 * Returns its own teardown, and is idempotent: calling it twice does not stack
 * listeners, which matters under React 18+ StrictMode and under HMR.
 */
export function startInstallCapture(win: Window = window): () => void {
  teardown?.();
  active = win;

  const onBeforeInstallPrompt = (event: Event) => {
    // Without this Chromium shows its own mini-infobar, and the app loses the
    // ability to choose the moment.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    refresh();
  };
  const onInstalled = () => {
    installed = true;
    deferred = null;
    refresh();
  };

  win.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  win.addEventListener('appinstalled', onInstalled);

  // The display mode can change under a live document — a learner installs from
  // the browser menu, or (in the e2e) the mode is emulated after load — and a
  // card that still offers to install an installed app is the failure this
  // listener removes.
  const queries =
    typeof win.matchMedia === 'function'
      ? DISPLAY_MODES.map((mode) => win.matchMedia(`(display-mode: ${mode})`))
      : [];
  for (const query of queries) query.addEventListener('change', refresh);

  refresh();

  teardown = () => {
    win.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    win.removeEventListener('appinstalled', onInstalled);
    for (const query of queries) query.removeEventListener('change', refresh);
    teardown = null;
  };
  return teardown;
}

/** `useSyncExternalStore`'s subscribe. */
export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `useSyncExternalStore`'s getSnapshot. Stable identity until something changes. */
export function readInstallState(): InstallState {
  return snapshot;
}

/**
 * Show Chromium's install dialog. Must be called from a user gesture, and the
 * event is spent either way — Chromium will fire a fresh one later if the site
 * is still installable, which is why `deferred` is cleared rather than kept.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null;
  refresh();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    // A spent or rejected prompt is not something the learner can act on, and
    // `appinstalled` is what would tell us it worked anyway.
    return 'dismissed';
  }
}

/** Test seam: forget the captured event and the listeners. */
export function resetInstallCapture(): void {
  teardown?.();
  deferred = null;
  installed = false;
  active = typeof window === 'undefined' ? undefined : window;
  snapshot = compute();
  listeners.clear();
}
