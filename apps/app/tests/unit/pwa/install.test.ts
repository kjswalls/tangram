/**
 * The install capture and its platform branch (docs/plans/web.md W5).
 *
 * The branch has no observable output other than the state it publishes, which
 * is why it is a module with a store rather than logic inside a component: the
 * three engines cannot all be visited in one browser, and the one case that
 * matters most — WebKit, which never fires the event — is the one this container
 * has no way to run at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectEngine,
  isStandalone,
  promptInstall,
  readInstallState,
  resetInstallCapture,
  startInstallCapture,
  subscribeInstall,
  type BeforeInstallPromptEvent,
} from '@/src/pwa/install';

/** A window with exactly the surface the module reads. */
function fakeWindow(options: {
  userAgent: string;
  firesEvent?: boolean;
  displayMode?: string;
  iosStandalone?: boolean;
}) {
  const listeners = new Map<string, Set<EventListener>>();
  const queries = new Map<string, { matches: boolean; listeners: Set<() => void> }>();

  const win = {
    navigator: { userAgent: options.userAgent, standalone: options.iosStandalone },
    addEventListener(type: string, listener: EventListener) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    matchMedia(query: string) {
      const mode = /\(display-mode: ([a-z-]+)\)/.exec(query)?.[1] ?? '';
      const entry = queries.get(query) ?? { matches: mode === options.displayMode, listeners: new Set() };
      queries.set(query, entry);
      return {
        get matches() {
          return entry.matches;
        },
        addEventListener: (_: string, fn: () => void) => entry.listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => entry.listeners.delete(fn),
      };
    },
    dispatch(type: string, event: Partial<Event> = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event as Event);
    },
    setDisplayMode(mode: string) {
      for (const [query, entry] of queries) {
        entry.matches = query.includes(`(display-mode: ${mode})`);
        for (const fn of entry.listeners) fn();
      }
    },
  };
  if (options.firesEvent ?? true) {
    (win as Record<string, unknown>).onbeforeinstallprompt = null;
  }
  return win as unknown as Window & {
    dispatch(type: string, event?: Partial<Event>): void;
    setDisplayMode(mode: string): void;
  };
}

const CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0';

afterEach(() => {
  resetInstallCapture();
});

describe('detectEngine', () => {
  it('reads the three engines whose install stories differ', () => {
    expect(detectEngine(CHROME)).toBe('chromium');
    expect(detectEngine(SAFARI)).toBe('webkit');
    expect(detectEngine(IPHONE)).toBe('webkit');
    expect(detectEngine(FIREFOX)).toBe('firefox');
  });

  it('does not call a Chromium browser WebKit because its UA says Safari', () => {
    // Every Chromium UA on every platform carries "Safari", and every browser
    // on iOS carries "Safari" AND "like Gecko". Getting this backwards would
    // show Chrome users Safari's Add-to-Home-Screen instructions.
    expect(detectEngine('… Chrome/140.0 Safari/537.36')).toBe('chromium');
    expect(detectEngine('… CriOS/140.0 Mobile/15E148 Safari/604.1')).toBe('chromium');
    expect(detectEngine('… EdgiOS/140.0 Mobile/15E148 Safari/605.1')).toBe('chromium');
    expect(detectEngine('… FxiOS/142.0 Mobile/15E148 Safari/605.1')).toBe('firefox');
  });
});

describe('isStandalone', () => {
  it('is true for every display mode that is not a browser tab', () => {
    for (const mode of ['standalone', 'window-controls-overlay', 'minimal-ui', 'fullscreen']) {
      expect(isStandalone(fakeWindow({ userAgent: CHROME, displayMode: mode })), mode).toBe(true);
    }
    expect(isStandalone(fakeWindow({ userAgent: CHROME, displayMode: 'browser' }))).toBe(false);
  });

  it('honours `navigator.standalone`, which is the only signal older iOS gives', () => {
    expect(
      isStandalone(fakeWindow({ userAgent: IPHONE, displayMode: 'browser', iosStandalone: true })),
    ).toBe(true);
  });
});

describe('the capture', () => {
  it('keeps the event, suppresses the mini-infobar, and offers a prompt', () => {
    const win = fakeWindow({ userAgent: CHROME, displayMode: 'browser' });
    startInstallCapture(win);
    expect(readInstallState().affordance).toBe('none');

    const preventDefault = vi.fn();
    win.dispatch('beforeinstallprompt', { preventDefault });

    // Without preventDefault Chromium shows its own bar and the app loses the
    // choice of moment — which is the whole reason the event is captured.
    expect(preventDefault).toHaveBeenCalled();
    expect(readInstallState().affordance).toBe('prompt');
  });

  it('notifies subscribers, and returns a stable snapshot between changes', () => {
    const win = fakeWindow({ userAgent: CHROME, displayMode: 'browser' });
    startInstallCapture(win);
    const listener = vi.fn();
    subscribeInstall(listener);

    const first = readInstallState();
    expect(readInstallState()).toBe(first); // `useSyncExternalStore` compares by identity.

    win.dispatch('beforeinstallprompt', { preventDefault: () => {} });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readInstallState()).not.toBe(first);

    // A second event with nothing new to say must not re-render the tree.
    win.dispatch('beforeinstallprompt', { preventDefault: () => {} });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('never offers to install an app that is already installed', () => {
    const win = fakeWindow({ userAgent: CHROME, displayMode: 'standalone' });
    startInstallCapture(win);
    expect(readInstallState().affordance).toBe('installed');

    // Even with an event in hand: Chromium does not fire one for an installed
    // app, but the store must not depend on that being true.
    win.dispatch('beforeinstallprompt', { preventDefault: () => {} });
    expect(readInstallState().affordance).toBe('installed');
  });

  it('follows the display mode changing under a live document', () => {
    const win = fakeWindow({ userAgent: CHROME, displayMode: 'browser' });
    startInstallCapture(win);
    win.dispatch('beforeinstallprompt', { preventDefault: () => {} });
    expect(readInstallState().affordance).toBe('prompt');

    // The learner installs from the browser menu, or the e2e emulates the mode
    // after load. A card still offering Install is the bug this listener closes.
    win.setDisplayMode('standalone');
    expect(readInstallState().affordance).toBe('installed');
  });

  it('takes `appinstalled` as the end of the matter', () => {
    const win = fakeWindow({ userAgent: CHROME, displayMode: 'browser' });
    startInstallCapture(win);
    win.dispatch('beforeinstallprompt', { preventDefault: () => {} });
    win.dispatch('appinstalled');
    expect(readInstallState().affordance).toBe('installed');
  });

  it('gives WebKit instructions rather than a button it cannot honour', () => {
    const win = fakeWindow({ userAgent: IPHONE, displayMode: 'browser', firesEvent: false });
    startInstallCapture(win);
    expect(readInstallState()).toMatchObject({ affordance: 'instructions', engine: 'webkit' });
  });

  it('offers Firefox nothing, because there is nothing honest to offer', () => {
    const win = fakeWindow({ userAgent: FIREFOX, displayMode: 'browser', firesEvent: false });
    startInstallCapture(win);
    expect(readInstallState()).toMatchObject({ affordance: 'none', engine: 'firefox' });
  });

  it('is idempotent — a second start does not stack listeners', () => {
    const win = fakeWindow({ userAgent: CHROME, displayMode: 'browser' });
    startInstallCapture(win);
    startInstallCapture(win);
    const listener = vi.fn();
    subscribeInstall(listener);
    win.dispatch('beforeinstallprompt', { preventDefault: () => {} });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('promptInstall', () => {
  it('spends the event and reports the outcome', async () => {
    const win = fakeWindow({ userAgent: CHROME, displayMode: 'browser' });
    startInstallCapture(win);
    const prompt = vi.fn(async () => {});
    win.dispatch('beforeinstallprompt', {
      preventDefault: () => {},
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    } as unknown as BeforeInstallPromptEvent);

    await expect(promptInstall()).resolves.toBe('accepted');
    expect(prompt).toHaveBeenCalledTimes(1);
    // The event can only be prompted once, so the affordance goes away with it.
    expect(readInstallState().affordance).toBe('none');
    await expect(promptInstall()).resolves.toBe('unavailable');
  });

  it('treats a rejected prompt as a dismissal rather than an error on screen', async () => {
    const win = fakeWindow({ userAgent: CHROME, displayMode: 'browser' });
    startInstallCapture(win);
    win.dispatch('beforeinstallprompt', {
      preventDefault: () => {},
      prompt: async () => {
        throw new Error('already used');
      },
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    } as unknown as BeforeInstallPromptEvent);

    await expect(promptInstall()).resolves.toBe('dismissed');
  });
});
