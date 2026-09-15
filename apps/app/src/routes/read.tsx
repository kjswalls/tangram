import { PageHeader } from '@/components/shell/page-header';
import { DictGate } from '@/components/dict/dict-gate';
import { ReaderView } from '@/components/reader/reader-view';

import { RouteMarker } from './route-marker';

export function ReadRoute() {
  return (
    <>
      <RouteMarker path="/read" />
      <PageHeader title="Read">Paste anything; tap a word to look it up in its sentence.</PageHeader>
      <DictGate><ReaderView /></DictGate>
    </>
  );
}
