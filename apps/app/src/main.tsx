/**
 * The client entry (docs/plans/web.md W1).
 *
 * `createBrowserRouter` — data mode, per docs/STACK.md §2.3. Not framework mode:
 * this app is three tabs and a palette, and framework mode's file-route
 * conventions buy nothing it needs. The route table is a module, not a
 * directory convention, because `scripts/smoke.ts` derives its page list from a
 * module today and W2 needs it to keep doing so.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';

import '@/app/globals.css';
import { routes } from './routes';

const container = document.getElementById('root');
if (!container) throw new Error('index.html is missing #root');

/**
 * `basename` comes from the build's own base, not from a literal.
 *
 * The default build is `base: '/'`, so this is `'/'` and changes nothing. A
 * subpath build (`vite build --base=/sub/`) is a separate invocation whose
 * output is served only under that prefix, and without this the router would
 * match `/sub/` against `/`, find nothing, and render its own 404 — assets
 * loading correctly and the app still blank. `import.meta.env.BASE_URL` is
 * substituted at build time, so the two always agree.
 */
createRoot(container).render(
  <StrictMode>
    <RouterProvider router={createBrowserRouter(routes, { basename: import.meta.env.BASE_URL })} />
  </StrictMode>,
);
