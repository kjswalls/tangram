import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';

export default function ReviewPage() {
  return (
    <>
      <PageHeader title="Review">Grade what is due; the sentence you met it in comes too.</PageHeader>
      <Card title="Session">
        <p className="text-sm text-muted">Reviewing comes in Phase 2.</p>
      </Card>
    </>
  );
}
