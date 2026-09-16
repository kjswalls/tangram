import { TodayView } from '@/app/(today)/today-view';
import { PageHeader } from '@/components/shell/page-header';

import { RouteMarker } from './route-marker';

export function TodayRoute() {
  return (
    <>
      <RouteMarker path="/" />
      <PageHeader title="Today">Everything due, plus the new words you have room for.</PageHeader>
      <TodayView />
    </>
  );
}
