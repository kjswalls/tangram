/**
 * Focus and the announcement on a route change (docs/plans/web.md W8,
 * criterion 2 — "assert both").
 *
 * The e2e half of this runs against the real router and the real screens
 * (`tests/e2e/core/keyboard.spec.ts`). This half is here because the two rules
 * that make it correct are invisible from the outside: that the announcer keys
 * on the **pathname** and not the whole location — otherwise `?q=` rips focus
 * out of the lookup box on every keystroke — and that it focuses with
 * `preventScroll`, which is the only thing keeping it from undoing the scroll
 * restoration criterion 3 asks for.
 */
import { StrictMode, useState } from 'react';

import { useLocation, useNavigate } from 'react-router';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PageHeader } from '@/components/ui/page-header';
import {
  ANNOUNCE_DELAY_MS,
  claimRouteFocus,
  fallbackRouteName,
  FOCUS_CLAIM_GRACE_MS,
  HEADING_WAIT_MS,
  RouteAnnouncer,
  routeHeading,
} from '@/src/shell/route-announcer';

import { act, fireEvent, render, screen } from '../render';

/**
 * A page with a heading, a button that changes the path, and one that changes
 * only the search — the two cases the announcer has to tell apart.
 */
function Fixture() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <>
      <button data-testid="to-practice" onClick={() => navigate('/practice')}>
        practice
      </button>
      <button data-testid="to-library" onClick={() => navigate('/library')}>
        library
      </button>
      <button data-testid="to-list" onClick={() => navigate('/library/lists/abc')}>
        list
      </button>
      <button data-testid="search" onClick={() => navigate('/practice?q=%E6%89%93%E7%AE%97')}>
        search
      </button>
      <main>
        <PageHeader title={pathname.startsWith('/library') ? 'Library' : 'Practice'}>
          blurb
        </PageHeader>
      </main>
      <RouteAnnouncer />
    </>
  );
}

/** Like `Fixture`, but the destination carries a focusable box inside `<main>`. */
function ClaimFixture() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <>
      <button
        data-testid="claim-and-go"
        onClick={() => {
          claimRouteFocus('/library');
          navigate('/library');
        }}
      >
        go
      </button>
      <button
        data-testid="go-unclaimed"
        onClick={() => {
          navigate('/practice');
        }}
      >
        go
      </button>
      <main>
        <PageHeader title={pathname.startsWith('/library') ? 'Library' : 'Practice'}>
          blurb
        </PageHeader>
        {pathname.startsWith('/library') ? <input data-testid="box" /> : null}
      </main>
      <RouteAnnouncer />
    </>
  );
}

/**
 * The announcement lands a tick after the navigation — the region is cleared
 * first so that the same name twice still speaks. See the component's header.
 */
function settle() {
  act(() => {
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS + 10);
  });
}

describe('a deliberate navigation can claim focus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  /**
   * The regression this exists for: `Mod+K` from another tab navigates *and*
   * focuses the lookup box, and before the claim the announcer won two runs in
   * five (`tests/e2e/core/keyboard.spec.ts`). A unit test is the guard because
   * the e2e one passes three times in five on the broken code.
   */
  it('stands aside while the claimant focuses something inside the new view', () => {
    render(<ClaimFixture />);
    fireEvent.click(screen.getByTestId('claim-and-go'));
    // What `focusLookupInput` does, once the route has rendered its box.
    act(() => {
      screen.getByTestId('box').focus();
    });
    act(() => {
      vi.advanceTimersByTime(FOCUS_CLAIM_GRACE_MS + 10);
    });
    expect(document.activeElement).toBe(screen.getByTestId('box'));
  });

  /**
   * Deferral, not cancellation. The box lives inside `<DictGate>` and is simply
   * absent on an origin with no dictionary; if the announcer stood aside for
   * good, focus would sit on `<body>` — the trap it exists to prevent.
   */
  it('takes focus back when the claimant never lands it', () => {
    render(<ClaimFixture />);
    fireEvent.click(screen.getByTestId('claim-and-go'));
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    expect(document.activeElement).not.toBe(routeHeading());
    act(() => {
      vi.advanceTimersByTime(FOCUS_CLAIM_GRACE_MS + 10);
    });
    expect(document.activeElement).toBe(routeHeading());
  });

  /** A claim is spent by one route change and cannot silence a later one. */
  it('does not outlive the navigation it was made for', () => {
    render(<ClaimFixture />);
    fireEvent.click(screen.getByTestId('claim-and-go'));
    act(() => {
      screen.getByTestId('box').focus();
    });
    act(() => {
      vi.advanceTimersByTime(FOCUS_CLAIM_GRACE_MS + 10);
    });
    // A second, unclaimed navigation — to a *different* path, or there is no
    // route change to test — must move focus at once, not stand aside.
    fireEvent.click(screen.getByTestId('go-unclaimed'));
    expect(document.activeElement).toBe(routeHeading());
  });
});

describe('RouteAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says nothing on the first render', () => {
    render(<Fixture />);
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('');
  });

  it('moves focus to the new heading AND announces its name', () => {
    render(<Fixture />);
    fireEvent.click(screen.getByTestId('to-library'));
    settle();

    const heading = routeHeading();
    expect(heading).not.toBeNull();
    expect(heading?.textContent).toBe('Library');
    expect(document.activeElement).toBe(heading);
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('Library');
  });

  it('announces politely, in a region a screen reader is already watching', () => {
    render(<Fixture />);
    const region = screen.getByTestId('route-announcer');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('role', 'status');
    // `aria-atomic` so the whole name is read rather than the diff between two
    // route names that happen to share a word.
    expect(region).toHaveAttribute('aria-atomic', 'true');
  });

  it('does NOT move focus when only the search changes', () => {
    // This is what `?q=` does on every settled keystroke. An announcer keyed on
    // `location` rather than `location.pathname` would take focus out of the
    // lookup box in the middle of a word.
    render(<Fixture />);
    fireEvent.click(screen.getByTestId('to-practice'));
    settle();
    const box = document.createElement('input');
    document.body.append(box);
    box.focus();
    fireEvent.click(screen.getByTestId('search'));
    settle();
    expect(document.activeElement).toBe(box);
    box.remove();
  });

  it('focuses without scrolling, so scroll restoration survives a Back press', () => {
    render(<Fixture />);
    const before = routeHeading();
    const focus = vi.spyOn(before as HTMLElement, 'focus');
    fireEvent.click(screen.getByTestId('to-library'));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it('says nothing on the first render under StrictMode either', () => {
    // `src/main.tsx` wraps the app in StrictMode, whose development-mode
    // mount → cleanup → mount consumed a `useRef(true)` sentinel on the
    // discarded pass — so every `pnpm dev` session opened with focus yanked to
    // the heading and the route announced as if it had been navigated to.
    // Production React hid it; `tests/unit/render.tsx` has no StrictMode, so
    // nothing else would have caught it. Found by W8a's adversarial review.
    render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
    settle();
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('');
    expect(document.activeElement).toBe(document.body);
  });

  it('speaks again when two routes share a heading', () => {
    // Two lists can share a name. A live region announces on *mutation*, so
    // writing the same string says nothing at all — the region is cleared
    // first for exactly this. Found by W8a's adversarial review, when every
    // list was headed "Library"; the fixture keeps that shape because it is
    // the simplest pair of routes with one name.
    render(<Fixture />);
    fireEvent.click(screen.getByTestId('to-library'));
    settle();
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('Library');

    fireEvent.click(screen.getByTestId('to-list'));
    // Cleared first: this is the mutation that makes the next one audible.
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('');
    settle();
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('Library');
  });

  it('falls back to <main> when a route somehow has no heading', () => {
    function Headless() {
      const navigate = useNavigate();
      const { pathname } = useLocation();
      return (
        <>
          <button data-testid="go" onClick={() => navigate('/practice')}>
            go
          </button>
          <main data-testid="main">{pathname}</main>
          <RouteAnnouncer />
        </>
      );
    }
    render(<Headless />);
    fireEvent.click(screen.getByTestId('go'));
    settle();
    expect(document.activeElement).toBe(screen.getByTestId('main'));
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('Practice');
  });
});

/**
 * A list's page, reduced to what the announcer can see: a heading that is busy
 * until its name "loads", and that holds the *previous* list's name while it
 * is — which is what `ListDetail` looks like between two lists, before its
 * read for the new one lands. `load` is that read landing.
 */
function ListsFixture() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [loadedFor, setLoadedFor] = useState<string>(pathname);
  const name = (path: string) => (path.endsWith('/a') ? 'Verbs' : 'Food');
  const busy = loadedFor !== pathname;
  return (
    <>
      <button data-testid="to-a" onClick={() => navigate('/library/lists/a')}>
        a
      </button>
      <button data-testid="to-b" onClick={() => navigate('/library/lists/b')}>
        b
      </button>
      <button data-testid="load" onClick={() => setLoadedFor(pathname)}>
        load
      </button>
      {/* Where the fixture started, so its heading is not busy on the way back. */}
      <button data-testid="to-start" onClick={() => navigate('/')}>
        start
      </button>
      <button
        data-testid="claim-to-b"
        onClick={() => {
          claimRouteFocus('/library/lists/b');
          navigate('/library/lists/b');
        }}
      >
        claim b
      </button>
      <main>
        <PageHeader title={name(loadedFor)} busy={busy} />
        <input data-testid="in-view" aria-label="something in the view" />
      </main>
      <RouteAnnouncer />
    </>
  );
}

describe('a heading whose name is still loading', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  /**
   * Criterion 4 of the wide-shell phase: moving from list A to list B
   * announces each list's own name. Without the wait, the region is filled at
   * the commit — when the heading still says "Verbs" at `/library/lists/b`.
   */
  it('announces the name that arrives, not the one the heading held at the commit', async () => {
    render(<ListsFixture />);
    fireEvent.click(screen.getByTestId('to-a'));
    fireEvent.click(screen.getByTestId('load'));
    settle();
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('Verbs');

    fireEvent.click(screen.getByTestId('to-b'));
    expect(routeHeading()).toHaveAttribute('aria-busy', 'true');
    settle();
    // Still loading: nothing is said rather than the wrong list's name.
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('');

    // The MutationObserver's callback is a microtask; flush it inside act.
    await act(async () => {
      fireEvent.click(screen.getByTestId('load'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('Food');
  });

  /** The name arriving: the busy heading's `aria-busy` clearing, flushed. */
  async function load() {
    await act(async () => {
      fireEvent.click(screen.getByTestId('load'));
      await Promise.resolve();
    });
  }

  /**
   * Focusing a heading is what makes a screen reader read it, and a busy one
   * reads as a blank level-1 heading — or, between two lists, as the previous
   * list's name. So focus waits for the name, as the announcement does.
   */
  it('does not focus the heading while it has no name, and does once it has one', async () => {
    render(<ListsFixture />);
    const trigger = screen.getByTestId('to-b');
    act(() => trigger.focus());
    fireEvent.click(trigger);
    expect(routeHeading()).toHaveAttribute('aria-busy', 'true');
    expect(document.activeElement).not.toBe(routeHeading());
    settle();
    expect(document.activeElement).not.toBe(routeHeading());

    await load();
    expect(routeHeading()).not.toHaveAttribute('aria-busy');
    expect(document.activeElement).toBe(routeHeading());
    expect(routeHeading()).toHaveTextContent('Food');
  });

  it('goes to <main> past the ceiling, never to the heading with no name', () => {
    render(<ListsFixture />);
    fireEvent.click(screen.getByTestId('to-b'));
    act(() => {
      vi.advanceTimersByTime(HEADING_WAIT_MS + 10);
    });
    expect(routeHeading()).toHaveAttribute('aria-busy', 'true');
    expect(document.activeElement).toBe(document.querySelector('main'));
  });

  it('leaves focus where the learner put it while the name loaded', async () => {
    render(<ListsFixture />);
    fireEvent.click(screen.getByTestId('to-b'));
    act(() => screen.getByTestId('in-view').focus());
    await load();
    expect(document.activeElement).toBe(screen.getByTestId('in-view'));
    // …and past the ceiling too.
    act(() => {
      vi.advanceTimersByTime(HEADING_WAIT_MS + 10);
    });
    expect(document.activeElement).toBe(screen.getByTestId('in-view'));
  });

  /**
   * The claim still defers first (`FOCUS_CLAIM_GRACE_MS`); a claimant that
   * never lands focus hands over to the same wait, not to the blank heading.
   */
  it('keeps the claim working: after the grace, an unlanded claim waits for the name too', async () => {
    render(<ListsFixture />);
    fireEvent.click(screen.getByTestId('claim-to-b'));
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    act(() => {
      vi.advanceTimersByTime(FOCUS_CLAIM_GRACE_MS + 10);
    });
    expect(document.activeElement).not.toBe(routeHeading());
    await load();
    expect(document.activeElement).toBe(routeHeading());
  });

  it('keeps the claim working: a claimant that lands focus keeps it after the name arrives', async () => {
    render(<ListsFixture />);
    fireEvent.click(screen.getByTestId('claim-to-b'));
    act(() => screen.getByTestId('in-view').focus());
    act(() => {
      vi.advanceTimersByTime(FOCUS_CLAIM_GRACE_MS + 10);
    });
    await load();
    expect(document.activeElement).toBe(screen.getByTestId('in-view'));
  });

  it('an abandoned wait moves nothing: the next route decides focus alone', async () => {
    render(<ListsFixture />);
    fireEvent.click(screen.getByTestId('to-b'));
    fireEvent.click(screen.getByTestId('to-a'));
    await load();
    expect(document.activeElement).toBe(routeHeading());
    expect(routeHeading()).toHaveTextContent('Verbs');
    // B's ceiling, had it survived, would now move focus to <main>.
    act(() => {
      vi.advanceTimersByTime(HEADING_WAIT_MS + 10);
    });
    expect(document.activeElement).toBe(routeHeading());
  });

  it('gives up waiting and names the route generically, rather than saying nothing', () => {
    render(<ListsFixture />);
    fireEvent.click(screen.getByTestId('to-b'));
    settle();
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('');
    act(() => {
      vi.advanceTimersByTime(HEADING_WAIT_MS + 10);
    });
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('Library');
  });

  it('stops waiting when the route changes again, and speaks for the new one', async () => {
    render(<ListsFixture />);
    fireEvent.click(screen.getByTestId('to-b'));
    settle();
    fireEvent.click(screen.getByTestId('to-a'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('load'));
      await Promise.resolve();
    });
    settle();
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('Verbs');
    // The abandoned wait for B must not fire later and overwrite it.
    act(() => {
      vi.advanceTimersByTime(HEADING_WAIT_MS + 10);
    });
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('Verbs');
  });
});

describe('an abandoned focus wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  /**
   * Leaving a busy route before its name arrives must cancel its wait. Left
   * running, its ceiling fires two seconds later and moves focus to `<main>` —
   * out of wherever the learner has gone since, such as the tabs in the header.
   */
  it('cannot pull focus out of the header two seconds later', () => {
    render(<ListsFixture />);
    fireEvent.click(screen.getByTestId('to-b'));
    fireEvent.click(screen.getByTestId('to-start'));
    // Not busy there: focus went straight to the heading.
    expect(document.activeElement).toBe(routeHeading());
    // The learner tabs out of the view, to a control outside `<main>`.
    act(() => screen.getByTestId('to-a').focus());
    act(() => {
      vi.advanceTimersByTime(HEADING_WAIT_MS + 10);
    });
    expect(document.activeElement).toBe(screen.getByTestId('to-a'));
  });
});

describe('fallbackRouteName', () => {
  it('names each tab, and the reader inside Look up', () => {
    expect(fallbackRouteName('/')).toBe('Look up');
    expect(fallbackRouteName('/practice')).toBe('Practice');
    expect(fallbackRouteName('/library')).toBe('Library');
    expect(fallbackRouteName('/library/lists/abc')).toBe('Library');
    expect(fallbackRouteName('/read')).toBe('Your own texts');
  });

  it('says something rather than nothing off the tab shell', () => {
    expect(fallbackRouteName('/nope')).toBe('Page');
  });
});
