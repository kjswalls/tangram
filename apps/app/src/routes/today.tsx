import { TodayView } from '@/app/(today)/today-view';
import { PageHeader } from '@/components/shell/page-header';

export function TodayRoute() {
  return (
    <>
      <PageHeader title="Today">Everything due, plus the new words you have room for.</PageHeader>
      <TodayView />
    </>
  );
}
