/**
 * What `?q=` actually hands the router (docs/plans/web.md W8).
 *
 * Split from `lookup-query.test.tsx` because it mocks `react-router` for the
 * whole module, and because the two things it asserts cannot be seen from the
 * outside in jsdom:
 *
 * - **`preventScrollReset: true` on every write.** React Router's
 *   `<ScrollRestoration>` ends its layout effect in `window.scrollTo(0, 0)` for
 *   any navigation that is not a POP with a saved position. A settled keystroke
 *   is a navigation, so without this flag the page jumps to the top while
 *   somebody types. `MemoryRouter` mounts no `<ScrollRestoration>`, so a test
 *   that watched `window.scrollTo` would pass against the bug — which is why
 *   this watches the option instead.
 * - **push once, then replace.** Asserted as the flag rather than by counting
 *   history entries, so a failure names the rule that broke.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLookupStore } from '@/lib/stores/lookup';
import { LookupQueryUrl, URL_DEBOUNCE_MS } from '@/src/url/lookup-query';

import { act, render } from '../render';

const captured = vi.hoisted(() => [] as { replace?: boolean; preventScrollReset?: boolean }[]);

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  function useSearchParams(...args: Parameters<typeof actual.useSearchParams>) {
    const [params, set] = actual.useSearchParams(...args);
    const wrapped: typeof set = (next, options) => {
      captured.push({ ...options });
      set(next, options);
    };
    return [params, wrapped] as ReturnType<typeof actual.useSearchParams>;
  }
  return { ...actual, useSearchParams };
});

describe('the navigations a lookup makes', () => {
  beforeEach(() => {
    captured.length = 0;
    vi.useFakeTimers();
    useLookupStore.setState({ query: '', selectedKey: undefined, entryIds: undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const type = (value: string) => {
    act(() => {
      useLookupStore.getState().setQuery(value);
    });
    act(() => {
      vi.advanceTimersByTime(URL_DEBOUNCE_MS + 10);
    });
  };

  it('never lets a write reset the scroll', () => {
    render(<LookupQueryUrl />);
    type('打');
    type('打算');
    type('');
    expect(captured.length).toBeGreaterThanOrEqual(3);
    for (const options of captured) expect(options.preventScrollReset).toBe(true);
  });

  it('pushes the first search and replaces every refinement of it', () => {
    render(<LookupQueryUrl />);
    type('打');
    expect(captured[0]?.replace).toBe(false);
    type('打算');
    expect(captured[1]?.replace).toBe(true);
    type('');
    expect(captured[2]?.replace).toBe(true);
    // …and the next search after an emptied box is a new one, so it pushes.
    type('好');
    expect(captured[3]?.replace).toBe(false);
  });

  it('replaces when it is only restoring a box that was already filled', () => {
    // The learner typed on this tab, went to Practice, came back. The box still
    // holds the word; the URL does not. Writing it back is bookkeeping.
    useLookupStore.setState({ query: '打算' });
    render(<LookupQueryUrl />);
    act(() => {
      vi.advanceTimersByTime(URL_DEBOUNCE_MS + 10);
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.replace).toBe(true);
  });
});
