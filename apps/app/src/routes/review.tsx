import { PageHeader } from '@/components/shell/page-header';
import { ReviewSession } from '@/components/review/review-session';

import { RouteMarker } from './route-marker';

export function ReviewRoute() {
  return (
    <>
      <RouteMarker path="/review" />
      <PageHeader title="Review">Grade what is due; the sentence you met it in comes too.</PageHeader>
      <ReviewSession />
    </>
  );
}
