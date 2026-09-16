import { LookUpScreen } from '@/components/screens/look-up';

/**
 * The Look up tab's route module (docs/plans/core.md C7).
 *
 * Route modules are thin on purpose: a screen must render the same wherever it
 * is put, so everything that is *about the route* — the path, the shell, the
 * navigation — stops here and the screen below knows none of it.
 */
export function LookUpRoute() {
  return <LookUpScreen />;
}
