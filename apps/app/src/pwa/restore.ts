/**
 * Telling the *other* tabs that the database underneath them was replaced
 * (docs/plans/web.md W5).
 *
 * `importAll` is destructive by contract, and the tab that pressed the button
 * reloads itself. Every other tab on this origin is still holding rows it read
 * before that happened, and nothing in IndexedDB tells it otherwise: a restore
 * does not bump the Dexie version, so there is no `versionchange` event, and
 * the app has no `liveQuery` subscription on the screens that matter.
 *
 * Be precise about what that costs, because the obvious statement of it is
 * wrong. `grade()` does **not** write a stale row back: it takes a `cardId` and
 * re-reads the card inside its own transaction, so a graded card is always the
 * restored one, and a card the restore removed makes it throw
 * `grade: no card <id>` rather than resurrect anything. What the stale tab
 * actually does is *show* a deck that no longer exists — a practice queue drawn
 * from cards that are gone, whose next grade is an error the learner cannot
 * explain. That is bad enough to close, and closing it is one message.
 *
 * `BroadcastChannel` does not deliver a message to the context that posted it,
 * so the restoring tab cannot reload itself twice, and a browser without the
 * API (or one that throws constructing it) simply keeps today's behaviour.
 *
 * **This is not sync.** It carries no rows and no state — just "reload". Merge
 * across devices is `backend.md` B5.
 */

const CHANNEL = 'tangram-restore';

function channel(win: Window): BroadcastChannel | null {
  try {
    const Ctor = (win as Window & { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    return typeof Ctor === 'function' ? new Ctor(CHANNEL) : null;
  } catch {
    return null;
  }
}

/** Post after `importAll` commits, before the restoring tab reloads itself. */
export function announceRestore(win: Window = window): void {
  const bus = channel(win);
  if (!bus) return;
  try {
    bus.postMessage({ type: 'restored', at: Date.now() });
  } finally {
    bus.close();
  }
}

/**
 * Listen for a restore in another tab and reload. Mounted once from
 * `src/main.tsx`; returns its own teardown.
 */
export function startRestoreListener(
  win: Window = window,
  reload: () => void = () => win.location.reload(),
): () => void {
  const bus = channel(win);
  if (!bus) return () => {};
  const onMessage = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data === 'object' && data !== null && (data as { type?: string }).type === 'restored') {
      reload();
    }
  };
  bus.addEventListener('message', onMessage);
  return () => {
    bus.removeEventListener('message', onMessage);
    bus.close();
  };
}
