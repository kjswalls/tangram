import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

import { PageHeader } from '@/components/ui/page-header';

/**
 * The 404 and the error boundary, which a data-mode router has neither of by
 * default (docs/plans/web.md W1).
 *
 * Without them React Router throws its own `ErrorResponse` for any unmatched
 * path and renders its built-in page — *replacing the whole tree*, header and
 * nav included, with an unstyled "Unexpected Application Error!" and no way
 * back. Under Next an unknown URL rendered a 404 inside the layout, so this is
 * a behaviour regression rather than a missing nicety. And because the SPA
 * fallback serves `index.html` for every path, an unmatched URL is not an
 * unusual case: it is what a stale bookmark, a mistyped link and a route the
 * app has since dropped all produce.
 *
 * It is attached as the root route's `errorElement` as well, so a throw from
 * any route component lands somewhere a learner can act on.
 */
export function NotFoundRoute() {
  const error = useRouteError();
  const is404 = error === undefined || (isRouteErrorResponse(error) && error.status === 404);

  return (
    <>
      <PageHeader title={is404 ? 'Not found' : 'Something went wrong'}>
        {is404
          ? 'That page does not exist. Nothing has been lost — your cards are in this browser.'
          : 'The page could not be shown. Your cards are in this browser and are unaffected.'}
      </PageHeader>
      <p className="text-sm">
        <Link to="/" className="text-accent underline">
          Go to Look up
        </Link>
      </p>
      {!is404 && error instanceof Error ? (
        <pre className="mt-4 overflow-x-auto rounded-md bg-surface p-3 font-mono text-xs text-muted">
          {error.message}
        </pre>
      ) : null}
    </>
  );
}
