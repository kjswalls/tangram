/**
 * `render`, with a router around it (docs/plans/web.md W1).
 *
 * Every component that renders a `<Link>` — the nav, the list cards, the Today
 * rows, the settings form, the review card — now needs a React Router context
 * to render at all; without one, `useContext` returns null and the component
 * throws before a single assertion runs. Under Next this was free, because
 * `next/link` needs no provider.
 *
 * `MemoryRouter` rather than the real table: these are component tests and the
 * URL is not what they are about. A test that cares which route a link points
 * at asserts the `href`, which `MemoryRouter` resolves exactly as the browser
 * router does.
 *
 * Re-exports the rest of `@testing-library/react` so a test file has one import
 * and cannot accidentally reach past the wrapper for the unwrapped `render`.
 */
import type { ReactElement, ReactNode } from 'react';

import { render as baseRender, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

function Wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

export function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return baseRender(ui, { wrapper: Wrapper, ...options });
}

export * from '@testing-library/react';
