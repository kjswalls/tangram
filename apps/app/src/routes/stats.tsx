import { PageHeader } from '@/components/shell/page-header';
import { StatsView } from '@/components/stats/stats-view';

export function StatsRoute() {
  return (
    <>
      <PageHeader title="Stats">
        Whether the schedule is working — read from your own review log, in this browser.
      </PageHeader>
      <StatsView />
    </>
  );
}
