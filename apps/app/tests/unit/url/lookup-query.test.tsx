/**
 * `?q=` (docs/plans/web.md W8).
 *
 * The URL is the lookup's shared state. What is checked here is the part that
 * is easy to get subtly wrong and impossible to see: that the two directions do
 * not echo each other forever, that a search starts one history entry and
 * refining it starts none, and that a write never resets the scroll — which it
 * would, because React Router's `<ScrollRestoration>` scrolls to the top of
 * every navigation that is not a POP with a saved position, and a settled
 * keystroke *is* a navigation.
 */
import { useEffect, useState } from 'react';

import { useLocation, useNavigate } from 'react-router';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLookupStore } from '@/lib/stores/lookup';
import {
  canonicalLookupQuery,
  lookupWriteMode,
  LookupQueryUrl,
  MAX_LOOKUP_QUERY_LENGTH,
  readLookupQuery,
  URL_DEBOUNCE_MS,
  writeLookupQuery,
} from '@/src/url/lookup-query';

import { act, fireEvent, render, screen } from '../render';

describe('the typed wrapper', () => {
  it('reads a missing, empty or whitespace-only q as nothing at all', () => {
    expect(readLookupQuery(new URLSearchParams(''))).toBe('');
    expect(readLookupQuery(new URLSearchParams('q='))).toBe('');
    expect(readLookupQuery(new URLSearchParams('q=%20%20'))).toBe('');
  });

  it('reads what was typed, spaces inside it and all', () => {
    expect(readLookupQuery(new URLSearchParams('q=da+suan'))).toBe('da suan');
    expect(readLookupQuery(new URLSearchParams('q=%E6%89%93%E7%AE%97'))).toBe('打算');
  });

  it('caps what the URL will carry', () => {
    const long = 'a'.repeat(MAX_LOOKUP_QUERY_LENGTH + 50);
    expect(canonicalLookupQuery(long)).toHaveLength(MAX_LOOKUP_QUERY_LENGTH);
    expect(readLookupQuery(new URLSearchParams(`q=${long}`))).toHaveLength(
      MAX_LOOKUP_QUERY_LENGTH,
    );
  });

  it('drops q rather than writing an empty one, and keeps other params', () => {
    const params = new URLSearchParams('q=x&key=abc');
    expect(writeLookupQuery(params, '').toString()).toBe('key=abc');
    expect(writeLookupQuery(params, '好').get('q')).toBe('好');
    expect(writeLookupQuery(params, '好').get('key')).toBe('abc');
  });

  it('does not mutate the params it was handed', () => {
    const params = new URLSearchParams('q=x');
    writeLookupQuery(params, '好');
    expect(params.get('q')).toBe('x');
  });
});

describe('lookupWriteMode', () => {
  const mode = (urlQuery: string, next: string) =>
    lookupWriteMode({ urlQuery, next, first: false, restoring: false });

  it('pushes when a search begins, so Back undoes it', () => {
    expect(mode('', '打算')).toBe('push');
  });

  it('replaces while the same search is refined, so Back is not a per-keystroke undo', () => {
    expect(mode('打', '打算')).toBe('replace');
    // A backspace is a refinement too — the same search, still being typed.
    expect(mode('打算', '打')).toBe('replace');
  });

  /**
   * The rule the adversarial review corrected.
   *
   * The first version pushed only when the URL had no `q`, so 打算 → 好 → 喜欢
   * was one history entry: one Back press landed on the empty page and the two
   * earlier searches were unreachable, which made this module's own promise
   * ("Back undoes a search") true of the last one only.
   */
  it('pushes a different word, because that is a new search and not a refinement', () => {
    expect(mode('打算', '好')).toBe('push');
    expect(mode('好', '喜欢')).toBe('push');
  });

  it('pushes when the box is cleared, so Back restores what was in it', () => {
    expect(mode('打算', '')).toBe('push');
  });

  it('replaces the first write when it is only restoring the box into the URL', () => {
    // Arriving on the tab with a query already in the store — the learner was
    // here earlier, or a reader tap filled it. That write is bookkeeping and
    // must not leave a history entry for Back to land on.
    expect(lookupWriteMode({ urlQuery: '', next: '打算', first: true, restoring: true })).toBe(
      'replace',
    );
  });

  it('…but a real search typed before that write lands still pushes', () => {
    // The race the review found: `restoring` used to be a flag that outlived
    // its case, so retyping inside the 300 ms before the restoring write landed
    // wrote the real search as a replace and Back left the app.
    expect(lookupWriteMode({ urlQuery: '', next: '好', first: true, restoring: false })).toBe(
      'push',
    );
  });
});

/**
 * The URL, and a way to change it, beside the thing under test.
 *
 * `initialQuery` navigates before `<LookupQueryUrl />` is mounted, which is the
 * only way to reach the cold-load case from inside a `MemoryRouter` that always
 * starts at `/`: the component has to find the query already there rather than
 * watch it arrive.
 */
function Fixture({ initialQuery }: { initialQuery?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [mounted, setMounted] = useState(initialQuery === undefined);
  useEffect(() => {
    if (initialQuery === undefined) return;
    navigate(`/?q=${initialQuery}`, { replace: true });
    setMounted(true);
  }, [initialQuery, navigate]);
  return (
    <>
      {mounted ? <LookupQueryUrl /> : null}
      <span data-testid="search">{location.search}</span>
      <button data-testid="go" onClick={() => navigate('/?q=%E6%89%93%E7%AE%97')}>
        go
      </button>
      <button data-testid="back" onClick={() => navigate(-1)}>
        back
      </button>
    </>
  );
}

describe('LookupQueryUrl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLookupStore.setState({ query: '', selectedKey: undefined, entryIds: undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = () => {
    act(() => {
      vi.advanceTimersByTime(URL_DEBOUNCE_MS + 10);
    });
  };

  /**
   * The case `pnpm e2e` caught and the first version of this file did not.
   *
   * `synced` used to be seeded from the URL at the first render, so a cold load
   * of `/?q=打算` found the two "already agreed" and pushed nothing into the
   * box — the shared link, which is the whole point of putting the query in the
   * URL, opened on an empty search. The mount is its own case now (rule 4 in
   * `lookup-query.ts`), and these two are the two halves of it.
   */
  it('opens a shared link: a URL with q wins over an empty box, on mount', () => {
    useLookupStore.setState({ query: '' });
    render(<Fixture initialQuery="%E6%89%93%E7%AE%97" />);
    expect(useLookupStore.getState().query).toBe('打算');
  });

  it('…and does not wipe a box that already has something in it', () => {
    // Coming back to the tab: the store is a module singleton and still holds
    // the last search, and a tab link carries no query. "The URL wins" applied
    // here empties the box the learner was looking at.
    useLookupStore.setState({ query: 'dasuan' });
    render(<Fixture />);
    expect(useLookupStore.getState().query).toBe('dasuan');
    settle();
    expect(screen.getByTestId('search')).toHaveTextContent('?q=dasuan');
  });

  it('puts the URL into the box', () => {
    render(<Fixture />);
    act(() => {
      fireEvent.click(screen.getByTestId('go'));
    });
    expect(useLookupStore.getState().query).toBe('打算');
  });

  it('puts the box into the URL, once the typing stops', () => {
    render(<Fixture />);
    act(() => {
      useLookupStore.getState().setQuery('好');
    });
    // Nothing yet: a URL write per keystroke is a history entry per keystroke.
    expect(screen.getByTestId('search')).toHaveTextContent('');
    settle();
    expect(decodeURIComponent(screen.getByTestId('search').textContent ?? '')).toBe('?q=好');
  });

  it('writes once for a word typed a letter at a time', () => {
    render(<Fixture />);
    for (const value of ['d', 'da', 'das', 'dasu', 'dasuan']) {
      act(() => {
        useLookupStore.getState().setQuery(value);
      });
      act(() => {
        vi.advanceTimersByTime(50);
      });
    }
    settle();
    expect(screen.getByTestId('search')).toHaveTextContent('?q=dasuan');
  });

  it('walks back through a sequence of different searches, one at a time', () => {
    render(<Fixture />);
    for (const word of ['打算', '好', '喜欢']) {
      act(() => {
        useLookupStore.getState().setQuery(word);
      });
      settle();
    }
    expect(decodeURIComponent(screen.getByTestId('search').textContent ?? '')).toBe('?q=喜欢');
    act(() => {
      fireEvent.click(screen.getByTestId('back'));
    });
    expect(decodeURIComponent(screen.getByTestId('search').textContent ?? '')).toBe('?q=好');
    expect(useLookupStore.getState().query).toBe('好');
    act(() => {
      fireEvent.click(screen.getByTestId('back'));
    });
    expect(decodeURIComponent(screen.getByTestId('search').textContent ?? '')).toBe('?q=打算');
  });

  it('settles rather than echoing: one search is one history entry', () => {
    // The anti-echo assertion, written as the thing a learner would notice.
    // If the URL write bounced back into the box and out again, the extra
    // navigations would be extra history entries and one Back press would land
    // in the middle of the word rather than on the empty page.
    render(<Fixture />);
    act(() => {
      useLookupStore.getState().setQuery('dasuan');
    });
    settle();
    settle();
    settle();
    expect(screen.getByTestId('search')).toHaveTextContent('?q=dasuan');
    act(() => {
      fireEvent.click(screen.getByTestId('back'));
    });
    settle();
    expect(screen.getByTestId('search')).toHaveTextContent('');
    expect(useLookupStore.getState().query).toBe('');
  });

  it('empties the box when the URL loses its q', () => {
    render(<Fixture />);
    act(() => {
      fireEvent.click(screen.getByTestId('go'));
    });
    expect(useLookupStore.getState().query).toBe('打算');
    act(() => {
      fireEvent.click(screen.getByTestId('back'));
    });
    expect(useLookupStore.getState().query).toBe('');
  });

});
