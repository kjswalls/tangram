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
import { StrictMode } from 'react';

import { useLocation, useNavigate } from 'react-router';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PageHeader } from '@/components/ui/page-header';
import {
  ANNOUNCE_DELAY_MS,
  claimRouteFocus,
  fallbackRouteName,
  FOCUS_CLAIM_GRACE_MS,
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
    // `/library` and one list inside it are both headed "Library". A live
    // region announces on *mutation*, so writing the same string says nothing
    // at all — the region is cleared first for exactly this. Found by W8a's
    // adversarial review.
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
