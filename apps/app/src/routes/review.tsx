import { PageHeader } from '@/components/shell/page-header';
import { ReviewSession } from '@/components/review/review-session';

export function ReviewRoute() {
  return (
    <>
      <PageHeader title="Review">Grade what is due; the sentence you met it in comes too.</PageHeader>
      <ReviewSession />
    </>
  );
}
