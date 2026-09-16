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
import { initAccess } from './access/client';
import { routes } from './routes';

const container = document.getElementById('root');
if (!container) throw new Error('index.html is missing #root');

/**
 * The `?key=` exchange, **before the first render** (docs/plans/web.md W4).
 *
 * It has to run before anything can reach the API: a component that fires a
 * gated request during its first effect would send it without the credential
 * that is sitting in the URL bar. It also rewrites the address bar, and doing
 * that before the router is constructed means `createBrowserRouter` reads the
 * URL the learner is meant to be on rather than the one carrying the secret.
 *
 * Not awaited. The key is stripped and stored synchronously, before the first
 * `await` inside; what the promise carries is the server's verdict, which lands
 * a round trip later and only decides whether the credential is kept. Blocking
 * the first render on a network round trip would put a blank screen in front of
 * every learner who has a key, to answer a question none of them asked.
 */
void initAccess();

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
