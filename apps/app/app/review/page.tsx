import { ReviewSession } from '@/components/review/review-session';
import { PageHeader } from '@/components/shell/page-header';

export default function ReviewPage() {
  return (
    <>
      <PageHeader title="Review">Grade what is due; the sentence you met it in comes too.</PageHeader>
      <ReviewSession />
    </>
  );
}
