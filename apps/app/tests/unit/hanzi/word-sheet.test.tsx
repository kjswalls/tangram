/**
 * The word sheet (docs/plans/core.md C4), and specifically the two properties
 * "Mark known" had to keep when it was folded out of
 * `components/reader/reader-lookup.tsx`:
 *
 *  1. **it marks the reading the sheet is SHOWING.** The default is the ranked
 *     entry, because `entryIds` is frequency-ordered — but a learner looking at
 *     reading B of a polyphone marks reading B. Marking the frequency-first
 *     reading there would colour a word known on the strength of a reading the
 *     learner never looked at, which is the reader's whole colour model wrong.
 *  2. **a rejected write is visible.** The old file set a `markError` flag and
 *     said so; a button that looks pressed and wrote nothing is worse than an
 *     error, because the passage's colouring silently disagrees with the
 *     database from then on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WordSheet, groupFromEntries } from '@/components/hanzi/word-sheet';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import type { SearchResult } from '@/lib/dict/search';
import type { DictEntry } from '@/lib/dict/types';
import type { Entry } from '@/lib/types';

import { fireEvent, render, screen, waitFor } from '../render';

afterEach(async () => {
  vi.restoreAllMocks();
  await getDb().delete();
  await closeDb();
});

/** 了 — the polyphone the lookup route's own spec uses. `le` is the frequent one. */
const LE: Entry = {
  id: '了|了[le5]',
  simp: '了',
  trad: '了',
  pinyinNum: 'le5',
  pinyinMarked: 'le',
  glosses: ['(modal particle)'],
  classifiers: [],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 1,
};
const LIAO: Entry = {
  id: '了|了[liao3]',
  simp: '了',
  trad: '了',
  pinyinNum: 'liao3',
  pinyinMarked: 'liǎo',
  glosses: ['to finish', 'to understand'],
  classifiers: [],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 4,
};

/** A store that answers from a fixed list. Structurally a `DictStore` slice. */
function source(entries: readonly Entry[]) {
  return {
    status: { state: 'ready', version: 'test' } as const,
    entries: async (): Promise<DictEntry[]> => [...entries] as DictEntry[],
    search: async (): Promise<SearchResult> => ({
      query: '',
      route: 'hanzi',
      groups: [],
      sections: [],
      total: 0,
      offset: 0,
      dictVersion: 'test',
    }),
  };
}

function sheet(store: ReturnType<typeof source>) {
  return (
    <WordSheet
      open
      query="了"
      entryIds={[LE.id, LIAO.id]}
      store={store}
      onClose={() => undefined}
    />
  );
}

describe('Mark known', () => {
  it('marks the RANKED entry by default — the one the sheet opened on', async () => {
    render(sheet(source([LE, LIAO])));
    await waitFor(() => {
      expect(screen.getByTestId('entry-detail')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('mark-known'));
    await waitFor(async () => {
      expect(await getRepository().knownEntryIds()).toEqual([LE.id]);
    });
  });

  it('marks the reading the learner PICKED, not the frequency-first one', async () => {
    render(sheet(source([LE, LIAO])));
    await waitFor(() => {
      expect(screen.getAllByTestId('reading-option').length).toBe(2);
    });

    // Pick liǎo — the rarer reading, second in the frequency-ordered list.
    fireEvent.click(screen.getAllByTestId('reading-option')[1]);
    await waitFor(() => {
      expect(screen.getByTestId('entry-detail').getAttribute('data-entry-id')).toBe(LIAO.id);
    });

    fireEvent.click(screen.getByTestId('mark-known'));
    await waitFor(async () => {
      expect(await getRepository().knownEntryIds()).toEqual([LIAO.id]);
    });
    // And emphatically not the frequent one.
    expect(await getRepository().knownEntryIds()).not.toContain(LE.id);
  });

  it('says so when the write is rejected, rather than looking pressed', async () => {
    render(sheet(source([LE, LIAO])));
    await waitFor(() => {
      expect(screen.getByTestId('entry-detail')).toBeTruthy();
    });

    vi.spyOn(getRepository(), 'markKnown').mockRejectedValue(new Error('quota'));
    fireEvent.click(screen.getByTestId('mark-known'));

    await waitFor(() => {
      expect(screen.getByText('Could not mark that known.')).toBeTruthy();
    });
    // The button is still offered: the learner can try again.
    expect(screen.getByTestId('mark-known')).not.toBeDisabled();
    expect(await getRepository().knownEntryIds()).toEqual([]);
  });

  it('reads `known_words` live rather than remembering the press', async () => {
    await getRepository().markKnown([LE.id]);
    render(sheet(source([LE, LIAO])));
    await waitFor(() => {
      expect(screen.getByTestId('mark-known').textContent).toBe('Marked known');
    });
    expect(screen.getByTestId('mark-known')).toBeDisabled();
  });
});

/**
 * **Nothing about the previous word survives into the next one.**
 *
 * The sheet is one long-lived instance in the reader — a tap swaps `query`
 * rather than remounting — and the fold introduced exactly this regression:
 * `showing`, the reading `EntryDetail` reports, outlived its word, so between
 * the tap and the entries resolving (and permanently for a word CC-CEDICT has
 * no headword for) the sheet showed one word and "Mark known" wrote another.
 */
describe('across a change of word', () => {
  function withEntries(entries: readonly Entry[], settle = true) {
    return {
      status: { state: 'ready', version: 'test' } as const,
      entries: async (): Promise<DictEntry[]> =>
        settle ? ([...entries] as DictEntry[]) : new Promise<DictEntry[]>(() => {}),
      search: async (): Promise<SearchResult> => ({
        query: '',
        route: 'hanzi',
        groups: [],
        sections: [],
        total: 0,
        offset: 0,
        dictVersion: 'test',
      }),
    };
  }

  it('cannot mark the previous word while the next one is still resolving', async () => {
    const view = render(
      <WordSheet open query="了" entryIds={[LE.id]} store={withEntries([LE])} onClose={() => undefined} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('entry-detail')).toBeTruthy();
    });

    // A second word whose entries never arrive.
    view.rerender(
      <WordSheet
        open
        query="工作"
        entryIds={['工作|工作[gong1 zuo4]']}
        store={withEntries([], false)}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('entry-detail')).toBeNull();
    });
    expect(screen.getByTestId('mark-known')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mark-known'));
    expect(await getRepository().knownEntryIds()).toEqual([]);
  });

  it('cannot mark the previous word when the next one has no headword at all', async () => {
    const view = render(
      <WordSheet open query="了" entryIds={[LE.id]} store={withEntries([LE])} onClose={() => undefined} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('entry-detail')).toBeTruthy();
    });

    view.rerender(
      <WordSheet open query="工作" entryIds={['nope']} store={withEntries([])} onClose={() => undefined} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/has no headword/)).toBeTruthy();
    });
    // No "了 is known" badge under a sheet that is showing 工作.
    expect(screen.queryByText('is known')).toBeNull();
    expect(screen.getByTestId('mark-known')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mark-known'));
    expect(await getRepository().knownEntryIds()).toEqual([]);
  });
});

describe('groupFromEntries', () => {
  it('keeps every reading and takes the easiest band', () => {
    const group = groupFromEntries([LE, LIAO]);
    expect(group?.entries).toHaveLength(2);
    expect(group?.hskBand).toBe(1);
    expect(group?.matchedIds).toEqual([LE.id, LIAO.id]);
  });

  it('is undefined for no entries, so the caller renders the "no headword" line', () => {
    expect(groupFromEntries([])).toBeUndefined();
  });
});
