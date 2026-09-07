import { ReaderView } from '@/components/reader/reader-view';
import { PageHeader } from '@/components/shell/page-header';

export default function ReadPage() {
  return (
    <>
      <PageHeader title="Read">Paste anything; tap a word to look it up in its sentence.</PageHeader>
      <ReaderView />
    </>
  );
}
