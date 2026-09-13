'use client';

/**
 * The `/read` route's one client boundary: the paste box, or the reading view.
 *
 * Which of the two is showing lives in the store rather than in local state, so
 * a trip to `/review` and back returns to the text where it was — the "survives
 * navigation" half of §3.5. The other half is the `texts` row the composer
 * writes before it segments.
 */

import { ReaderScreen } from '@/components/reader/reader-screen';
import { TextComposer } from '@/components/reader/text-composer';
import { useReaderStore } from '@/lib/stores/reader';

export function ReaderView() {
  const view = useReaderStore((state) => state.view);
  const tokens = useReaderStore((state) => state.tokens);
  const body = useReaderStore((state) => state.body);

  const reading = view === 'read' && body.length > 0 && tokens.length > 0;
  return reading ? <ReaderScreen /> : <TextComposer />;
}
