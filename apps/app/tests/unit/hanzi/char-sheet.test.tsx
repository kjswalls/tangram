/**
 * The character sheet (docs/plans/core.md C4) — and the licence boundary,
 * **executed** rather than grepped.
 *
 * The first version of this check read `char-sheet.tsx` as a string and
 * asserted it mentioned `decompose(` and did not mention `addCard`. That is a
 * test of the file's spelling: renaming a local variable broke it, while adding
 * a `fetch('/api/ask')` carrying the decomposition — the exact violation the
 * component's header names — left it green. So the sheet is rendered here, and
 * the two things that must not happen are watched for as they would happen:
 *
 *  1. **no decomposition text leaves the browser.** Every `fetch` is recorded
 *     and every request body is searched for the IDS string and the radical.
 *  2. **no decomposition field reaches a card.** The row an Add writes is read
 *     back out of the repository.
 *
 * `data/decomp.json` is Make Me a Hanzi, LGPL-3.0-or-later; the dictionary is
 * CC-CEDICT, CC BY-SA 4.0 (CLAUDE.md, "Data and licences"; PLAN.md §5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CharSheet } from '@/components/hanzi/char-sheet';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import type { DecompCharacter, DecompStore } from '@/lib/dict/decomp-store';
import type { SearchResult } from '@/lib/dict/search';
import type { Entry } from '@/lib/types';

import { fireEvent, render, screen, waitFor } from '../render';

/** 继 — a real headword with a real decomposition. */
const JI: Entry = {
  id: '繼|继[ji4]',
  simp: '继',
  trad: '繼',
  pinyinNum: 'ji4',
  pinyinMarked: 'jì',
  glosses: ['to continue', 'to follow after'],
  classifiers: [],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 4,
};

const IDS = '⿰纟米';
const RADICAL = '纟';

const decompStore: DecompStore = {
  async decompose(chars: string): Promise<DecompCharacter[]> {
    return [...chars].map((char) => ({
      char,
      entry: { decomposition: IDS, radical: RADICAL, definition: 'to continue' },
    }));
  },
};

const store = {
  status: { state: 'ready', version: 'test' } as const,
  async search(): Promise<SearchResult> {
    return {
      query: '继',
      route: 'hanzi',
      groups: [
        {
          key: `${JI.trad}|${JI.simp}`,
          simp: JI.simp,
          trad: JI.trad,
          source: 'hanzi',
          matchedIds: [JI.id],
          entries: [JI],
          hskBand: 4,
        },
      ],
      sections: [],
      total: 1,
      offset: 0,
      dictVersion: 'test',
    };
  },
};

/** Every request the sheet makes, body included. */
let sent: string[] = [];

beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    sent.push(`${String(input)} ${typeof init?.body === 'string' ? init.body : ''}`);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await getDb().delete();
  await closeDb();
});

function sheet() {
  return (
    <CharSheet
      open
      char="继"
      store={store}
      decomp={decompStore}
      context={{ sentence: '下午继续工作。', offset: 2, length: 1, source: 'reader', addedAt: 1 }}
      onClose={() => undefined}
    />
  );
}

describe('the character sheet', () => {
  it('renders the decomposition it was given', async () => {
    render(sheet());
    await waitFor(() => {
      expect(screen.getByTestId('char-ids').textContent).toBe(IDS);
    });
    expect(screen.getByTestId('char-decomposition').textContent).toContain('Make Me a Hanzi');
  });

  it('sends no decomposition anywhere — not to the model, not to any route', async () => {
    render(sheet());
    await waitFor(() => {
      expect(screen.getByTestId('char-ids')).toBeTruthy();
    });
    // Whatever the sheet asked for, none of it carried the decomposition.
    for (const request of sent) {
      expect(request, request).not.toContain(IDS);
      expect(request, request).not.toContain(RADICAL);
    }
    // Not vacuous by construction: the string really is on screen.
    expect(screen.getByTestId('char-ids').textContent).toBe(IDS);
  });

  it('writes a card from the DICTIONARY row, with no decomposition field on it', async () => {
    render(sheet());
    await waitFor(() => {
      expect(screen.getByTestId('add-card')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('add-card'));

    await waitFor(async () => {
      expect(await getRepository().allCards()).toHaveLength(1);
    });
    const [card] = await getRepository().allCards();
    expect(card.entryId).toBe(JI.id);
    expect(card.context?.source).toBe('reader');
    // The character's own span, not the word's.
    expect(card.context?.length).toBe(1);

    const snapshot = card.snapshot as unknown as Record<string, unknown>;
    for (const field of ['decomposition', 'radical', 'definition']) {
      expect(snapshot, field).not.toHaveProperty(field);
    }
    expect(JSON.stringify(snapshot)).not.toContain(IDS);
    expect(snapshot.simp).toBe('继');
  });
});
