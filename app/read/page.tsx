import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';

export default function ReadPage() {
  return (
    <>
      <PageHeader title="Read">Paste anything; tap a word to look it up in its sentence.</PageHeader>
      <Card title="Text">
        <p className="text-sm text-muted">The reader comes in Phase 5.</p>
      </Card>
    </>
  );
}
