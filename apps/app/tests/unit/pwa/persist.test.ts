/**
 * `navigator.storage.persist()` and the copy it decides (docs/plans/web.md W5).
 *
 * Two things are tested here that a browser cannot be made to tell you:
 *
 * 1. **The request waits for an interaction.** Chromium answers `persist()`
 *    silently and does not reconsider for that page load, so calling it on first
 *    paint turns a grant into a permanent refusal. Nothing observable in a
 *    browser distinguishes "asked at the right moment" from "asked at the wrong
 *    one" — only the call order does, and that is what is asserted.
 * 2. **The pessimistic Safari branch.** Register #13 needs a Mac and this
 *    container has none, so the copy is written from the assumption that Safari
 *    did not persist and the seven-day cap applies. That assumption is a
 *    function, and this is where it is pinned so a later session cannot soften
 *    it by accident.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  onFirstInteraction,
  readPersisted,
  readPersistSnapshot,
  requestPersistence,
  resetPersistence,
  startPersistence,
  storageRisk,
  type StorageManagerLike,
} from '@/src/pwa/persist';

function fakeNavigator(storage?: StorageManagerLike): Navigator {
  return { storage } as unknown as Navigator;
}

afterEach(() => {
  resetPersistence();
});

describe('readPersisted', () => {
  it('asks the question without making the request', async () => {
    const persist = vi.fn(async () => true);
    const persisted = vi.fn(async () => false);
    await expect(readPersisted(fakeNavigator({ persist, persisted }))).resolves.toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it('answers “do not know” rather than “no” when the API is absent or throws', async () => {
    await expect(readPersisted(fakeNavigator())).resolves.toBeNull();
    await expect(
      readPersisted(
        fakeNavigator({
          // A private window can throw here. Reporting that as `false` would put
          // a warning in front of a learner who may be perfectly safe.
          persisted: async () => {
            throw new Error('denied');
          },
        }),
      ),
    ).resolves.toBeNull();
  });
});

describe('requestPersistence', () => {
  it('asks, then reads back, and prefers what the origin says over what the call returned', async () => {
    // `persist()` resolving false while `persisted()` is true is the real case
    // where another tab already earned the grant.
    const snapshot = await requestPersistence(
      fakeNavigator({ persist: async () => false, persisted: async () => true }),
    );
    expect(snapshot).toEqual({ state: 'persisted', asked: true, persisted: true });
  });

  it('records a refusal as a refusal', async () => {
    const snapshot = await requestPersistence(
      fakeNavigator({ persist: async () => false, persisted: async () => false }),
    );
    expect(snapshot).toEqual({ state: 'transient', asked: true, persisted: false });
    expect(readPersistSnapshot()).toEqual(snapshot);
  });

  it('reports “unsupported” rather than “refused” when there is no API', async () => {
    const snapshot = await requestPersistence(fakeNavigator());
    expect(snapshot).toEqual({ state: 'unsupported', asked: false, persisted: null });
  });

  it('falls back to what persist() said when persisted() is missing', async () => {
    const snapshot = await requestPersistence(fakeNavigator({ persist: async () => true }));
    expect(snapshot).toMatchObject({ state: 'persisted', asked: true, persisted: true });
  });
});

describe('onFirstInteraction', () => {
  it('runs once, on the first of the three events, and then unhooks', () => {
    const run = vi.fn();
    onFirstInteraction(run, window);

    window.dispatchEvent(new Event('keydown'));
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('touchstart'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled before it fires', () => {
    const run = vi.fn();
    onFirstInteraction(run, window)();
    window.dispatchEvent(new Event('pointerdown'));
    expect(run).not.toHaveBeenCalled();
  });
});

describe('startPersistence', () => {
  it('reads on start and does NOT ask until the learner interacts', async () => {
    const persist = vi.fn(async () => true);
    const persisted = vi.fn(async () => false);
    const win = Object.create(window, {
      navigator: { value: fakeNavigator({ persist, persisted }) },
    }) as Window;

    startPersistence(win);
    await vi.waitFor(() => expect(readPersistSnapshot().persisted).toBe(false));
    // The whole point of the phase's second deliverable: nothing was requested
    // during load.
    expect(persisted).toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(readPersistSnapshot()).toMatchObject({ asked: false, state: 'transient' });

    win.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(readPersistSnapshot().asked).toBe(true));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not ask again when the origin is already persisted', async () => {
    const persist = vi.fn(async () => true);
    const win = Object.create(window, {
      navigator: { value: fakeNavigator({ persist, persisted: async () => true }) },
    }) as Window;

    startPersistence(win);
    await vi.waitFor(() => expect(readPersistSnapshot().state).toBe('persisted'));
    win.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('storageRisk — the copy the learner sees', () => {
  const base = { standalone: false, engine: 'chromium', hasCards: true } as const;

  it('is quiet when the origin is persisted', () => {
    expect(storageRisk({ ...base, state: 'persisted' })).toBe('safe');
    expect(storageRisk({ ...base, state: 'persisted', engine: 'webkit' })).toBe('safe');
  });

  it('is quiet for an installed app on either engine', () => {
    // WebKit exempts a Home-Screen or Dock app from the seven-day cap and
    // Chromium grants persistence to an installed origin (STACK §2.8).
    expect(storageRisk({ ...base, state: 'transient', standalone: true })).toBe('safe');
    expect(storageRisk({ ...base, state: 'unknown', standalone: true, engine: 'webkit' })).toBe(
      'safe',
    );
  });

  it('WARNS a non-installed Safari tab holding cards, even when nothing has been measured', () => {
    // Register #13 is unrun: nobody has established that Safari honours
    // `persist()` for a non-installed site. `web.md` W5 says to write this from
    // the pessimistic assumption, so `state: 'unknown'` must still warn.
    expect(storageRisk({ ...base, state: 'unknown', engine: 'webkit' })).toBe('at-risk');
    expect(storageRisk({ ...base, state: 'transient', engine: 'webkit' })).toBe('at-risk');
    expect(storageRisk({ ...base, state: 'unsupported', engine: 'webkit' })).toBe('at-risk');
  });

  it('does not warn a learner with nothing to lose yet', () => {
    expect(storageRisk({ ...base, state: 'transient', engine: 'webkit', hasCards: false })).toBe(
      'unknown',
    );
  });

  it('warns a Chromium tab only once the refusal is a fact', () => {
    // Chromium's grant is silent and its refusal is silent, so an unanswered
    // state is genuinely unknown rather than dangerous — but a measured refusal
    // on an origin holding cards is the eviction case.
    expect(storageRisk({ ...base, state: 'unknown' })).toBe('unknown');
    expect(storageRisk({ ...base, state: 'transient' })).toBe('at-risk');
  });
});
