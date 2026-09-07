/**
 * Leaving the reader clears the selection with the lookup context (§3.5).
 *
 * `ReaderScreen` already closed the lookup store on unmount, but `selected`
 * lived in the reader store and survived a trip to /review or the Edit view. On
 * the way back `open` was still true, so the panel reopened on the last tapped
 * token with no sentence and no resolved entry ids: it re-searched the bare
 * string, and an Add from it carried no provenance at all — which is commitment
 * 2 of §1 quietly failing.
 */
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ReaderScreen } from '@/components/reader/reader-screen';
import { closeDb, getDb } from '@/lib/db/get-db';
import { useLookupStore } from '@/lib/stores/lookup';
import { useReaderStore } from '@/lib/stores/reader';
import type { Token } from '@/lib/types';

const BODY = '我每天早上七点起床。';

const TOKENS: Token[] = [
  { text: '我', start: 0, end: 1, kind: 'word', entryIds: ['我|我[wo3]'], via: 'entry' },
  { text: '每天', start: 1, end: 3, kind: 'word', entryIds: ['每天|每天[mei3 tian1]'], via: 'entry' },
];

afterEach(async () => {
  useLookupStore.getState().closeLookup();
  useReaderStore.getState().clear();
  await getDb().delete();
  await closeDb();
});

describe('the reading view', () => {
  it('drops the selection and the context together when it unmounts', () => {
    useReaderStore.setState({ body: BODY, tokenizedBody: BODY, tokens: TOKENS, view: 'read' });
    useReaderStore.getState().select(1);
    useLookupStore.getState().openLookup({
      query: '每天',
      entryIds: ['每天|每天[mei3 tian1]'],
      context: { sentence: BODY, offset: 1, length: 2, source: 'reader', addedAt: 1 },
    });

    const view = render(<ReaderScreen />);
    expect(useReaderStore.getState().selected).toBe(1);

    view.unmount();

    expect(useLookupStore.getState().context).toBeUndefined();
    expect(useLookupStore.getState().entryIds).toBeUndefined();
    // The half that used to survive: a panel reopening on this would have no
    // sentence to put on a card.
    expect(useReaderStore.getState().selected).toBeUndefined();
  });
});
