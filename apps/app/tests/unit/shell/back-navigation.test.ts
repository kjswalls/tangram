/**
 * The hardware back button's four rules (`docs/plans/android.md` A1).
 *
 * A1's criterion 6 is a hand-run device checklist — overlay open, route history
 * non-empty, tab root with a previous tab, first-tab root — and this repository
 * has no device and no CI (STACK §5.9). What it *can* do is hold the policy in a
 * pure model and assert every row of that checklist here, so the device pass
 * checks wiring rather than logic. The checklist in `HANDOFF.md` names this file
 * beside each row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeTopOverlay,
  createBackNavigation,
  hasOpenOverlay,
  registerOverlay,
  resetOverlays,
} from '@/lib/shell/back-navigation';

/** The shell A1 actually ships against: `components/shell/nav.ts`'s seven. */
const SEVEN = ['/', '/lookup', '/review', '/read', '/lists', '/stats', '/settings'];

/** What `core.md` C7 re-baselines it to. Look up is first, so it is rule 4's. */
const THREE = ['/lookup', '/practice', '/library'];

describe('rule 1 — an open overlay swallows the press', () => {
  beforeEach(resetOverlays);

  it('closes the overlay and stops, whatever the tab state', () => {
    const nav = createBackNavigation(THREE);
    nav.visit('/library');
    nav.visit('/library/hsk-1');
    const close = vi.fn();
    registerOverlay(close);

    expect(nav.handleBack({ overlayOpen: hasOpenOverlay() })).toEqual({ type: 'close-overlay' });
    // "and stops": the route stack is untouched, so the next press pops it.
    expect(nav.snapshot().depth).toBe(1);
  });

  it('closes the top overlay only — a dialog over a sheet leaves the sheet', () => {
    const sheet = vi.fn();
    const dialog = vi.fn();
    registerOverlay(sheet);
    registerOverlay(dialog);

    expect(closeTopOverlay()).toBe(true);
    expect(dialog).toHaveBeenCalledOnce();
    expect(sheet).not.toHaveBeenCalled();
    expect(hasOpenOverlay()).toBe(true);
  });

  it('is inert, not wrong, while nothing registers overlays', () => {
    // core.md C1's Sheet is not on this branch. Until it registers, rule 1 must
    // fall through to rule 2 rather than swallowing presses.
    expect(hasOpenOverlay()).toBe(false);
    expect(closeTopOverlay()).toBe(false);
  });

  it('unregistering a closed overlay removes that one, not the top', () => {
    const sheet = vi.fn();
    const dialog = vi.fn();
    const unregisterSheet = registerOverlay(sheet);
    registerOverlay(dialog);

    unregisterSheet();
    expect(closeTopOverlay()).toBe(true);
    expect(dialog).toHaveBeenCalledOnce();
    expect(hasOpenOverlay()).toBe(false);
  });
});

describe('rule 2 — pop the current tab before leaving it', () => {
  it('pops while the tab stack is deeper than its root', () => {
    const nav = createBackNavigation(THREE);
    nav.visit('/library');
    nav.visit('/library/hsk-1');
    nav.visit('/library/hsk-1/entry');

    expect(nav.snapshot().depth).toBe(2);
    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'pop' });
  });

  it('counts depth per tab, so a deep A does not keep B from switching', () => {
    const nav = createBackNavigation(THREE);
    nav.visit('/library');
    nav.visit('/library/hsk-1');
    nav.visit('/practice');

    expect(nav.snapshot()).toMatchObject({ current: '/practice', depth: 0 });
    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'switch-tab', to: '/library' });
  });

  it('attributes an unenumerated route to the tab the learner is in', () => {
    // A detail route no tab list covers must still be popped rather than
    // treated as a tab switch — otherwise back leaves the tab from a child page.
    const nav = createBackNavigation(THREE);
    nav.visit('/library');
    nav.visit('/entry/中文');

    expect(nav.snapshot()).toMatchObject({ current: '/library', depth: 1 });
    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'pop' });
  });

  it("a POP arrival unwinds the stack it came from", () => {
    const nav = createBackNavigation(THREE);
    nav.visit('/library');
    nav.visit('/library/hsk-1');
    nav.visit('/library/hsk-1/entry');
    nav.visit('/library/hsk-1', 'POP');

    expect(nav.snapshot().depth).toBe(1);
  });

  it('REPLACE does not deepen the stack', () => {
    const nav = createBackNavigation(THREE);
    nav.visit('/library');
    nav.visit('/library/hsk-1');
    nav.visit('/library/hsk-2', 'REPLACE');

    expect(nav.snapshot().depth).toBe(1);
  });

  it('treats re-entering a tab root as the ordinary history entry it is', () => {
    // Tapping the tab you are already on pushes, so back returns to the page you
    // left — which is what the browser would do and what the router reports. A
    // shell that wants "tap the current tab to go home" navigates with `replace`,
    // and the model collapses that instead of leaving a duplicate to pop through.
    const push = createBackNavigation(THREE);
    push.visit('/library');
    push.visit('/library/hsk-1');
    push.visit('/library');
    // Two entries below, both in this tab: the detail page and the first visit
    // to the root. `depth` counts the run, not one step of it.
    expect(push.snapshot().depth).toBe(2);
    expect(push.handleBack({ overlayOpen: false })).toEqual({ type: 'pop' });

    const replace = createBackNavigation(THREE);
    replace.visit('/library');
    replace.visit('/library/hsk-1');
    replace.visit('/library', 'REPLACE');
    expect(replace.snapshot()).toMatchObject({ depth: 0, historyDepth: 0 });
    expect(replace.handleBack({ overlayOpen: false })).toEqual({ type: 'background' });
  });

  it('ignores a repeated arrival at the same path', () => {
    // A re-render that re-reports the same location must not look like a push.
    const nav = createBackNavigation(THREE);
    nav.visit('/library');
    nav.visit('/library/hsk-1');
    nav.visit('/library/hsk-1');

    expect(nav.snapshot().depth).toBe(1);
  });

  it('treats a trailing slash as the same tab root', () => {
    const nav = createBackNavigation(THREE);
    nav.visit('/library/');

    expect(nav.snapshot()).toMatchObject({ current: '/library', depth: 0 });
  });
});

describe('rule 3 — walk the most-recently-visited tab stack, and pop it', () => {
  it('returns to the tab actually visited before, not the one to the left', () => {
    // A1's own example: Look up → Library → Practice. Back goes to Library.
    const nav = createBackNavigation(THREE);
    nav.visit('/lookup');
    nav.visit('/library');
    nav.visit('/practice');

    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'switch-tab', to: '/library' });
  });

  it('walks the whole stack out and then backgrounds — it never ping-pongs', () => {
    // The echo trap: the switch produces a router arrival at the target tab. If
    // that arrival re-pushed the tab we left, back would alternate between two
    // tabs forever. Every switch is followed here by the arrival it causes.
    const nav = createBackNavigation(THREE);
    nav.visit('/lookup');
    nav.visit('/library');
    nav.visit('/practice');

    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'switch-tab', to: '/library' });
    nav.visit('/library');
    expect(nav.snapshot()).toMatchObject({ current: '/library', mru: ['/lookup'] });

    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'switch-tab', to: '/lookup' });
    nav.visit('/lookup');
    expect(nav.snapshot()).toMatchObject({ current: '/lookup', mru: [] });

    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'background' });
  });

  it('visits a tab once in the stack however many times it is revisited', () => {
    const nav = createBackNavigation(THREE);
    nav.visit('/lookup');
    nav.visit('/library');
    nav.visit('/lookup');
    nav.visit('/practice');

    // Not ['/lookup', '/library', '/lookup'] — the stack is most-recently-visited.
    expect(nav.snapshot().mru).toEqual(['/library', '/lookup']);
  });

  it('pops the current tab before consulting the stack', () => {
    const nav = createBackNavigation(THREE);
    nav.visit('/lookup');
    nav.visit('/practice');
    nav.visit('/practice/session');

    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'pop' });
  });
});

describe('rule 4 — background at the root of the first tab', () => {
  it('backgrounds from the first tab even with a stack behind it', () => {
    const nav = createBackNavigation(THREE);
    nav.visit('/practice');
    nav.visit('/lookup');

    expect(nav.snapshot().mru).toEqual(['/practice']);
    // Rule 3 is explicitly "if the tab is not the first tab". At the first tab's
    // root the app backgrounds, which is what every phone app does.
    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'background' });
  });

  it('backgrounds when the tab stack is exhausted on a non-first tab', () => {
    const nav = createBackNavigation(THREE);
    nav.visit('/practice');

    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'background' });
  });

  it('backgrounds on a press before any navigation has been recorded', () => {
    // The very first press, if the effect that feeds the model has not run.
    const nav = createBackNavigation(THREE);

    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'background' });
  });
});

describe("the seven-route shell A1 actually ships against", () => {
  it("makes '/' the tab the app backs out of, and does not swallow the others", () => {
    const nav = createBackNavigation(SEVEN);
    nav.visit('/');
    nav.visit('/lookup');

    // '/' is a prefix of every path; longest-match is what keeps /lookup its own
    // tab. Without it the whole app would be one tab and rule 3 would be dead.
    expect(nav.snapshot()).toMatchObject({ current: '/lookup', depth: 0 });
    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'switch-tab', to: '/' });
  });

  it('pops within a route that lives under a tab', () => {
    const nav = createBackNavigation(SEVEN);
    nav.visit('/lists');
    nav.visit('/lists/abc');

    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'pop' });
  });

  it('refuses an empty tab list rather than deciding nothing', () => {
    expect(() => createBackNavigation([])).toThrow(/at least one tab/);
  });
});

describe('the four hazards that only show up on a device', () => {
  it('never claims a pop the router cannot perform — a cold start below a tab root', () => {
    // A deep link, or a restored session, lands straight on /lists/abc. The tab
    // has a page below its root and `navigate(-1)` has nowhere to go: pressing
    // back would do nothing at all, which reads as a broken button.
    const nav = createBackNavigation(SEVEN);
    nav.visit('/lists/abc', 'POP');

    expect(nav.snapshot()).toMatchObject({ current: '/lists', depth: 0, historyDepth: 0 });
    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'background' });
  });

  it('does not promise a pop that would land in a different tab', () => {
    // /lists/N entered straight from /stats: the *tab* has a page below it, but
    // the history entry below is /stats. A model that answered "pop" here would
    // promise to stay in the tab and leave it. Repeated, so a stale per-tab
    // stack would also show up as an unbounded depth.
    const nav = createBackNavigation(SEVEN);
    nav.visit('/', 'POP');
    for (let i = 0; i < 5; i += 1) {
      nav.visit('/stats');
      nav.visit(`/lists/${i}`);
      expect(nav.snapshot().depth, `cycle ${i}`).toBe(0);
      expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'switch-tab', to: '/stats' });
      nav.visit('/stats'); // the echo of the switch
    }
    expect(nav.snapshot()).toMatchObject({ current: '/stats', depth: 0 });
  });

  it('does promise a pop when the entry below really is in this tab', () => {
    const nav = createBackNavigation(SEVEN);
    nav.visit('/', 'POP');
    nav.visit('/lists');
    nav.visit('/lists/abc');

    expect(nav.snapshot()).toMatchObject({ current: '/lists', depth: 1 });
    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'pop' });
  });

  it('does not send the learner back to the tab they are standing in', () => {
    // Today -> Look up -> Review -> Look up. Back must walk out through Review
    // and Today, never returning to Look up on the way.
    const nav = createBackNavigation(SEVEN);
    nav.visit('/', 'POP');
    nav.visit('/lookup');
    nav.visit('/review');
    nav.visit('/lookup');

    const walk: string[] = [];
    for (let press = 0; press < 6; press += 1) {
      const action = nav.handleBack({ overlayOpen: false });
      if (action.type !== 'switch-tab') {
        walk.push(action.type);
        break;
      }
      walk.push(action.to);
      nav.visit(action.to); // the router echo the mount produces
    }

    expect(walk).toEqual(['/review', '/', 'background']);
  });

  it("files a path under no tab root with the learner's tab, not with '/'", () => {
    // '/' is a tab root, not a namespace. As a prefix it matches everything, so
    // an entry opened from Look up would be filed under Today and back would
    // leave the tab.
    const nav = createBackNavigation(SEVEN);
    nav.visit('/', 'POP');
    nav.visit('/lookup');
    nav.visit('/entry/中文');

    expect(nav.snapshot()).toMatchObject({ current: '/lookup', depth: 1 });
    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'pop' });
  });

  it('ignores a query string and a hash', () => {
    // A search box that writes ?q= on every keystroke must not look like a
    // history entry per character.
    const nav = createBackNavigation(SEVEN);
    nav.visit('/', 'POP');
    nav.visit('/lookup');
    nav.visit('/lookup?q=%E4%BD%A0');
    nav.visit('/lookup?q=%E4%BD%A0%E5%A5%BD');
    nav.visit('/lookup#results');

    expect(nav.snapshot()).toMatchObject({ current: '/lookup', depth: 0 });
    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'switch-tab', to: '/' });
  });
});

describe('two presses before the router answers the first', () => {
  it('re-issues the same switch instead of popping two tabs', () => {
    // A phone delivers two presses inside one frame happily enough, and
    // `handleBack` mutates: without this, one arrival consumes two entries of
    // the most-recently-visited stack, a tab is skipped on the way out, and the
    // app backgrounds a press early.
    const nav = createBackNavigation(THREE);
    nav.visit('/lookup');
    nav.visit('/library');
    nav.visit('/practice');

    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'switch-tab', to: '/library' });
    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'switch-tab', to: '/library' });

    nav.visit('/library'); // the one arrival both presses produce
    expect(nav.snapshot().mru).toEqual(['/lookup']);
    expect(nav.handleBack({ overlayOpen: false })).toEqual({ type: 'switch-tab', to: '/lookup' });
  });
});
