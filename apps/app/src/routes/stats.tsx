import { PageHeader } from '@/components/shell/page-header';
import { StatsView } from '@/components/stats/stats-view';

import { RouteMarker } from './route-marker';

export function StatsRoute() {
  return (
    <>
      <RouteMarker path="/stats" />
      <PageHeader title="Stats">
        Whether the schedule is working — read from your own review log, in this browser.
      </PageHeader>
      <StatsView />
    </>
  );
}
