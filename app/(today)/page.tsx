import { PageHeader } from '@/components/shell/page-header';
import { TodayView } from './today-view';

export default function TodayPage() {
  return (
    <>
      <PageHeader title="Today">Everything due, plus the new words you have room for.</PageHeader>
      <TodayView />
    </>
  );
}
