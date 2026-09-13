import { PageHeader } from '@/components/shell/page-header';
import { ReaderView } from '@/components/reader/reader-view';

export function ReadRoute() {
  return (
    <>
      <PageHeader title="Read">Paste anything; tap a word to look it up in its sentence.</PageHeader>
      <ReaderView />
    </>
  );
}
