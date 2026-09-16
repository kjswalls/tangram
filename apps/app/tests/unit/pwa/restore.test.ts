/**
 * The cross-tab restore signal (docs/plans/web.md W5).
 *
 * The tab that restores reloads itself. This is the other tabs, and the reason
 * it exists is written out in `src/pwa/restore.ts`: nothing in IndexedDB tells
 * them, because a restore does not bump the Dexie version.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { announceRestore, startRestoreListener } from '@/src/pwa/restore';

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function listen(reload: () => void) {
  const stop = startRestoreListener(window, reload);
  stops.push(stop);
  return stop;
}

/**
 * `BroadcastChannel` delivery is a task, not a microtask — and in Node it is a
 * task that crosses worker threads, so a fixed `setTimeout(0)` is a flake under
 * a parallel suite rather than a wait. (It was one: this file passed alone and
 * failed once in a full run before this changed.) Positive cases wait for the
 * effect; the negative ones give delivery a generous window to fail in.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('the restore signal', () => {
  it('reloads a listening tab when another one restores', async () => {
    const reload = vi.fn();
    listen(reload);

    announceRestore(window);

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('ignores traffic that is not a restore', async () => {
    const reload = vi.fn();
    listen(reload);

    const bus = new BroadcastChannel('tangram-restore');
    bus.postMessage({ type: 'something-else' });
    bus.postMessage('hello');
    bus.postMessage(null);
    bus.close();
    await settled();

    expect(reload).not.toHaveBeenCalled();
  });

  it('stops listening when told to', async () => {
    const reload = vi.fn();
    listen(reload)();

    announceRestore(window);
    await settled();

    expect(reload).not.toHaveBeenCalled();
  });

  it('is a no-op where BroadcastChannel does not exist, rather than throwing', () => {
    // A browser without it keeps today's behaviour: the restoring tab reloads
    // and the others do not. A recovery tool must not fail on a missing
    // enhancement.
    const win = { location: { reload: () => {} } } as unknown as Window;
    expect(() => announceRestore(win)).not.toThrow();
    const stop = startRestoreListener(win, () => {});
    expect(() => stop()).not.toThrow();
  });

  it('carries no rows — it is a signal, not sync', async () => {
    const seen: unknown[] = [];
    const bus = new BroadcastChannel('tangram-restore');
    bus.addEventListener('message', (event) => seen.push(event.data));

    announceRestore(window);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    bus.close();

    // `backend.md` B5 owns merge. If a row ever appears in this message,
    // something has started replicating over a channel with no conflict policy.
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] as object).sort()).toEqual(['at', 'type']);
  });
});
