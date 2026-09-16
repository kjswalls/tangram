/**
 * `navigator.storage.persist()`, and what to tell a learner when it says no
 * (docs/plans/web.md W5).
 *
 * **Why it is not called on first paint.** Chromium never prompts: it grants
 * silently to an origin that is installed, bookmarked, notification-permitted or
 * engaged, and *refuses* silently to one that is none of those. The refusal is
 * not retried for that page load, so asking during the first paint of a first
 * visit converts a grant the learner would have earned a minute later into a
 * permanent no. Firefox is the mirror image: it shows a permission prompt, and a
 * prompt in front of an app the learner has not used yet is a prompt they
 * dismiss. So the request waits for a real interaction — the first pointer or
 * key event — and the result is read back and surfaced either way.
 *
 * **Register #13 is unanswered and the copy assumes the worst.** Whether Safari
 * honours `persist()` for a non-installed site needs a Mac, and this container
 * has none (`docs/STACK.md` §4). `web.md` W5 is explicit that until someone
 * runs it, the Safari warning is written from the pessimistic assumption: **not
 * persisted, and the seven-day cap applies.** `storageRisk` encodes exactly
 * that and nothing softer. See `HANDOFF.md`.
 *
 * What the app can honestly say, per engine:
 *
 * - `persisted() === true` → a quiet line. The origin is skipped by eviction.
 * - An installed app → safe enough to be quiet about, on both engines: WebKit
 *   exempts a Home-Screen or Dock app from the ITP cap and Chromium grants
 *   persistence to an installed origin.
 * - A **non-installed WebKit tab with cards in it** → a real warning, because
 *   that is the case where the cards can be gone in a week and nothing on screen
 *   would have said so.
 * - Anything else → the honest "this browser has not promised to keep it" line.
 */

/** What the browser said, after we asked. */
export type PersistState =
  /** Not asked yet, or asked and the answer has not come back. */
  | 'unknown'
  /** No `navigator.storage.persist` at all. */
  | 'unsupported'
  /** `persisted()` is true: eviction skips this origin. */
  | 'persisted'
  /** Asked, and the browser did not grant it. */
  | 'transient';

export interface PersistSnapshot {
  state: PersistState;
  /** Has `persist()` actually been called? The e2e asserts the path ran. */
  asked: boolean;
  /** What `persisted()` returned the last time it was read; `null` if never. */
  persisted: boolean | null;
}

/** Only the two members this module uses, so a test can pass a fake. */
export interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
}

function storageOf(nav: Navigator | undefined): StorageManagerLike | undefined {
  return (nav as (Navigator & { storage?: StorageManagerLike }) | undefined)?.storage;
}

let snapshot: PersistSnapshot = { state: 'unknown', asked: false, persisted: null };
const listeners = new Set<() => void>();

function publish(next: PersistSnapshot): void {
  if (
    next.state === snapshot.state &&
    next.asked === snapshot.asked &&
    next.persisted === snapshot.persisted
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore`'s pair. */
export function subscribePersist(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readPersistSnapshot(): PersistSnapshot {
  return snapshot;
}

/**
 * Read `persisted()` without asking for anything. Safe on first paint; it is a
 * question, not a request.
 */
export async function readPersisted(nav: Navigator = navigator): Promise<boolean | null> {
  const storage = storageOf(nav);
  if (typeof storage?.persisted !== 'function') return null;
  try {
    return await storage.persisted();
  } catch {
    // A private window can throw rather than resolve. That is "we do not know",
    // not "no" — and the difference is whether the learner gets a warning they
    // cannot act on.
    return null;
  }
}

/**
 * Ask, then read back. **Both halves matter**: `persist()`'s own return value is
 * what this call decided, and `persisted()` is the state of the origin, which
 * can already be true (in which case `persist()` resolves true without doing
 * anything) or can differ from a resolved-false request on an origin that was
 * granted by another tab.
 */
export async function requestPersistence(nav: Navigator = navigator): Promise<PersistSnapshot> {
  const storage = storageOf(nav);
  if (typeof storage?.persist !== 'function') {
    const next: PersistSnapshot = { state: 'unsupported', asked: false, persisted: null };
    publish(next);
    return next;
  }

  let granted: boolean | null = null;
  try {
    granted = await storage.persist();
  } catch {
    granted = null;
  }

  const after = await readPersisted(nav);
  // Prefer `persisted()`; fall back to what `persist()` said when the browser
  // has the one and not the other.
  const persisted = after ?? granted;
  const next: PersistSnapshot = {
    state: persisted === true ? 'persisted' : persisted === false ? 'transient' : 'unknown',
    asked: true,
    persisted,
  };
  publish(next);
  return next;
}

/**
 * Run `run` once, on the first real interaction.
 *
 * `pointerdown`, `keydown` and `touchstart` rather than `click`: a learner who
 * starts typing in the lookup box has interacted, and Chromium's engagement
 * heuristic counts that too. Capture-phase and passive, so nothing this listener
 * does can change how the app responds to the same event.
 */
export function onFirstInteraction(run: () => void, win: Window = window): () => void {
  const events = ['pointerdown', 'keydown', 'touchstart'] as const;
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    stop();
    run();
  };
  const stop = () => {
    for (const name of events) win.removeEventListener(name, fire, true);
  };
  for (const name of events) win.addEventListener(name, fire, { capture: true, passive: true });
  return stop;
}

/**
 * Wire it up: read the current state now, ask on the first interaction.
 * Called from `src/main.tsx`, once.
 */
export function startPersistence(win: Window = window): () => void {
  void readPersisted(win.navigator).then((persisted) => {
    // Never downgrade a completed request with this first read.
    if (snapshot.asked) return;
    publish({
      state: persisted === true ? 'persisted' : persisted === null ? 'unknown' : 'transient',
      asked: false,
      persisted,
    });
  });

  return onFirstInteraction(() => {
    if (snapshot.state === 'persisted') return;
    void requestPersistence(win.navigator);
  }, win);
}

/** How much the learner should worry, which is what decides the copy. */
export type StorageRisk = 'safe' | 'unknown' | 'at-risk';

export interface StorageRiskInput {
  state: PersistState;
  /** Installed, or in a native shell. */
  standalone: boolean;
  /** From `src/pwa/install.ts` — WebKit is the engine with the seven-day cap. */
  engine: 'chromium' | 'webkit' | 'firefox' | 'unknown';
  /** Nothing to lose yet is not a warning worth showing. */
  hasCards: boolean;
}

export function storageRisk({ state, standalone, engine, hasCards }: StorageRiskInput): StorageRisk {
  if (state === 'persisted') return 'safe';
  // An installed app is in a different storage regime on both engines
  // (STACK §2.8), so it is not the case this warning exists for — even when
  // `persisted()` came back false, which it can do in an installed Chromium
  // window that simply has not been asked yet.
  if (standalone) return 'safe';
  if (!hasCards) return 'unknown';
  // The pessimistic branch, per register #13: an uninstalled WebKit tab is
  // assumed NOT persisted and assumed to be under the seven-day cap.
  if (engine === 'webkit') return 'at-risk';
  return state === 'transient' ? 'at-risk' : 'unknown';
}

/** Test seam. */
export function resetPersistence(): void {
  snapshot = { state: 'unknown', asked: false, persisted: null };
  listeners.clear();
}
