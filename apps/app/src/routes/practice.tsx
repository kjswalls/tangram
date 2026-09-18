import { PracticeScreen } from '@/components/screens/practice';

import { RouteMarker } from './route-marker';

export function PracticeRoute() {
  return (
    <>
      <RouteMarker path="/practice" />
      <PracticeScreen />
    </>
  );
}
