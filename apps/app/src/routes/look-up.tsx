import { LookUpScreen } from '@/components/screens/look-up';

import { LookupQueryUrl } from '../url/lookup-query';

import { RouteMarker } from './route-marker';

/**
 * The Look up tab's route module (docs/plans/core.md C7).
 *
 * Route modules are thin on purpose: a screen must render the same wherever it
 * is put, so everything that is *about the route* — the path, the shell, the
 * navigation — stops here and the screen below knows none of it.
 *
 * `<LookupQueryUrl />` is `web.md` W8's, and it is here for that exact reason.
 * The query lives in the URL as `?q=` so a lookup can be linked, reloaded and
 * backed out of; the store is what the view reads; and the module that keeps
 * the two in step has to be one the router is allowed to reach. It renders
 * nothing.
 */
export function LookUpRoute() {
  return (
    <>
      <RouteMarker path="/" />
      <LookupQueryUrl />
      <LookUpScreen />
    </>
  );
}
