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
import { useLocation, useNavigate } from 'react-router';

import { describe, expect, it, vi } from 'vitest';

import { PageHeader } from '@/components/ui/page-header';
import { fallbackRouteName, RouteAnnouncer, routeHeading } from '@/src/shell/route-announcer';

import { fireEvent, render, screen } from '../render';

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
      <button data-testid="search" onClick={() => navigate('/practice?q=%E6%89%93%E7%AE%97')}>
        search
      </button>
      <main>
        <PageHeader title={pathname === '/library' ? 'Library' : 'Practice'}>blurb</PageHeader>
      </main>
      <RouteAnnouncer />
    </>
  );
}

describe('RouteAnnouncer', () => {
  it('says nothing on the first render', () => {
    render(<Fixture />);
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('');
  });

  it('moves focus to the new heading AND announces its name', () => {
    render(<Fixture />);
    fireEvent.click(screen.getByTestId('to-library'));

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
    const box = document.createElement('input');
    document.body.append(box);
    box.focus();
    fireEvent.click(screen.getByTestId('search'));
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
