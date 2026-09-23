/**
 * The wide shell's header stays on screen; the phone shell's does not change
 * (the wide-shell phase, criteria 1 and 5).
 *
 * The geometry is `tests/e2e/core/wide-shell.spec.ts`'s — jsdom lays nothing
 * out, so "the tab bar is visible at the bottom of Library" can only be
 * measured in a browser. What is here is the wiring the geometry depends on,
 * and it is the part that can regress silently: the header's height reaches
 * `<html>` only in the wide arrangement, the header is `fixed` rather than
 * `sticky` there (see `HEADER_HEIGHT_VAR` for the 364px that decided it), and
 * `globals.css` turns the height into the scroll padding that keeps focus out
 * from under the header.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell, HEADER_HEIGHT_VAR, PIN_QUERY, WIDE_QUERY } from '@/components/shell/app-shell';

import { render, screen } from '../render';

const appRoot = join(import.meta.dirname, '..', '..', '..');

/** A viewport: wide or not, and tall enough to pin the header or not. */
function mockViewport({ wide, tall = true }: { wide: boolean; tall?: boolean }) {
  vi.stubGlobal('matchMedia', (query: string) => {
    if (query !== WIDE_QUERY && query !== PIN_QUERY) throw new Error(`unexpected query ${query}`);
    return {
      matches: query === WIDE_QUERY ? wide : tall,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  });
}

const mockWide = (wide: boolean) => mockViewport({ wide });

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(HEADER_HEIGHT_VAR);
});

describe('the shell header', () => {
  it('is pinned in the wide arrangement, publishes its height, and pads the shell by it', () => {
    mockWide(true);
    render(<AppShell>page</AppShell>);
    expect(screen.getByTestId('wide-shell')).toBeInTheDocument();
    expect(screen.getByTestId('wide-shell')).toHaveAttribute('data-header', 'pinned');
    // `fixed`, not `sticky` — see `HEADER_HEIGHT_VAR`: a sticky header's own
    // links sit in the scroll padding, and focusing one moved the page 364px.
    expect(screen.getByTestId('shell-header').className).toMatch(/\bfixed\b/);
    expect(screen.getByTestId('shell-header').className).not.toMatch(/\bsticky\b/);
    expect(screen.getByTestId('shell-header').className).toMatch(/\btop-0\b/);
    expect(screen.getByTestId('wide-shell').className).toContain('pt-[var(--shell-header-height)]');
    // A tablet's status bar, under `viewport-fit=cover`; and a printed page.
    expect(screen.getByTestId('shell-header').className).toContain('pt-[env(safe-area-inset-top');
    expect(screen.getByTestId('shell-header').className).toMatch(/\bprint:static\b/);
    // jsdom measures everything as 0px; what matters is that it is written.
    expect(document.documentElement.style.getPropertyValue(HEADER_HEIGHT_VAR)).toBe('0px');
  });

  it('is unchanged in the phone arrangement: in flow, and no height on <html>', () => {
    mockWide(false);
    render(<AppShell>page</AppShell>);
    expect(screen.getByTestId('phone-shell')).toBeInTheDocument();
    expect(screen.getByTestId('shell-header').className).not.toMatch(/\b(sticky|fixed)\b/);
    expect(screen.getByTestId('phone-shell').className).not.toContain('shell-header-height');
    expect(document.documentElement.style.getPropertyValue(HEADER_HEIGHT_VAR)).toBe('');
  });

  /**
   * A phone on its side is wide, and a pinned header would hold a fifth of its
   * height for good (WCAG 1.4.10). Below `PIN_QUERY` the wide arrangement keeps
   * its tabs in the header and lets the header scroll away — so nothing reads a
   * height, and nothing pads for a header that is not over anything.
   */
  it('is wide but in flow on a short viewport: tabs in the header, no height on <html>', () => {
    mockViewport({ wide: true, tall: false });
    render(<AppShell>page</AppShell>);
    const shell = screen.getByTestId('wide-shell');
    expect(shell).toHaveAttribute('data-header', 'in-flow');
    const header = screen.getByTestId('shell-header');
    expect(header.className).not.toMatch(/\b(sticky|fixed)\b/);
    expect(header.className).not.toMatch(/\btop-0\b/);
    expect(shell.className).not.toContain('shell-header-height');
    expect(document.documentElement.style.getPropertyValue(HEADER_HEIGHT_VAR)).toBe('');
    // Still the wide arrangement: the tabs are in the header, not a bottom bar.
    expect(header.querySelector('[data-testid="tab-bar"]')).not.toBeNull();
    // And the status bar is still cleared, in flow as when pinned.
    expect(header.className).toContain('pt-[env(safe-area-inset-top');
  });

  it('the pin rule is a height, and the phone arrangement never pins', () => {
    expect(PIN_QUERY).toMatch(/^\(min-height: \d+(\.\d+)?rem\)$/);
    mockViewport({ wide: false, tall: true });
    render(<AppShell>page</AppShell>);
    expect(screen.getByTestId('phone-shell')).toHaveAttribute('data-header', 'in-flow');
    expect(document.documentElement.style.getPropertyValue(HEADER_HEIGHT_VAR)).toBe('');
  });

  it('takes its height back off <html> when it unmounts', () => {
    mockWide(true);
    const { unmount } = render(<AppShell>page</AppShell>);
    unmount();
    expect(document.documentElement.style.getPropertyValue(HEADER_HEIGHT_VAR)).toBe('');
  });

  /**
   * The rule that does the work, and the condition it is under. Scoped to the
   * wide arrangement so a phone's scroll-into-view lands exactly where it
   * always did; reading the variable so the padding is the measured height
   * rather than a guess at it.
   */
  it('is what the root scroll padding is made of, while the header is pinned only', () => {
    const css = readFileSync(join(appRoot, 'app', 'globals.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const rule = /:root:has\(\[data-header='pinned'\]\)\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'no pinned-only rule in globals.css').not.toBeNull();
    expect(rule?.[1]).toMatch(/scroll-padding-top:\s*calc\(var\(--shell-header-height\)/);
    // And nowhere unconditionally.
    const elsewhere = css.replace(rule?.[0] ?? '', '');
    expect(elsewhere).not.toMatch(/scroll-padding/);
  });
});
