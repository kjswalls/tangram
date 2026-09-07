import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';

export default function TodayPage() {
  return (
    <>
      <PageHeader title="Today">Everything due, plus the new words you have room for.</PageHeader>
      <Card title="Queue">
        <p className="text-sm text-muted">Today&rsquo;s counts come in Phase 3.</p>
      </Card>
    </>
  );
}
