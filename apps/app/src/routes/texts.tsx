import { TextsScreen } from '@/components/screens/texts';

import { RouteMarker } from './route-marker';

/** `/read` — a sub-path of the Look up tab, not a fourth destination (C7). */
export function TextsRoute() {
  return (
    <>
      <RouteMarker path="/read" />
      <TextsScreen />
    </>
  );
}
