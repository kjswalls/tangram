/**
 * A `DictStore` over a handful of entries, for jsdom tests.
 *
 * **Why `backend.md` B2 needs one and B1 did not.** Before the contract flip a
 * card back needed the dictionary for exactly one thing — resolving the ids the
 * route had already grounded — so `examples-card.test.tsx` got away with a
 * stand-in whose `search`, `segment` and `hskBand` threw. After the flip the
 * client retrieves, grounds and filters, so those three are on the hot path:
 * `offeredSupport` searches and expands bands, and `ground()` re-segments every
 * rendered phrase before it will call it verified.
 *
 * The implementations below are **deliberately naive and deliberately honest**.
 * Segmentation is greedy longest-match over the entries the test declared, which
 * is not what `lib/dict/segment.ts` does — it is a DP over jieba frequencies —
 * but it agrees with it on the only input these tests give it: a short phrase
 * built out of words the test itself supplied. Anything subtler than that
 * belongs in `tests/unit/dict/`, against the real artifact, where `data.md`
 * already tests it. What this file must never become is a second dictionary
 * implementation that a grounding test could agree with instead of the real one
 * — `tests/unit/ai/ask-client.test.ts` runs the same pipeline against the real
 * 124k-entry artifact for that reason.
 */
import type { DictStatus, DictStore } from '@/lib/dict/store';
import type { SearchGroup, SearchResult } from '@/lib/dict/search';
import type { SegmentResult } from '@/lib/dict/segment';
import type { Entry, HskBand, Token } from '@/lib/types';

export interface MemoryStoreOptions {
  version?: string;
  /** Counted per call, so a test can assert the network of queries it caused. */
  onEntries?: (ids: readonly string[]) => void;
}

export interface MemoryStore extends DictStore {
  /** Replace the rows. A rebuilt dictionary drops ids; this is how a test says so. */
  setEntries(entries: readonly Entry[]): void;
}

export function memoryStore(
  initial: readonly Entry[],
  options: MemoryStoreOptions = {},
): MemoryStore {
  let rows: Entry[] = [...initial];
  const status: DictStatus = { state: 'ready', version: options.version ?? '2026-01-01' };

  const byId = (): Map<string, Entry> => new Map(rows.map((entry) => [entry.id, entry]));

  /** Greedy longest-match over the declared headwords. See the header. */
  const segmentText = (text: string): Token[] => {
    const forms = new Map<string, string[]>();
    for (const entry of rows) {
      for (const form of [entry.simp, entry.trad]) {
        const ids = forms.get(form) ?? [];
        ids.push(entry.id);
        forms.set(form, ids);
      }
    }
    const longest = Math.max(1, ...[...forms.keys()].map((form) => form.length));
    const tokens: Token[] = [];
    let at = 0;
    while (at < text.length) {
      let taken = 0;
      for (let length = Math.min(longest, text.length - at); length >= 1; length -= 1) {
        const slice = text.slice(at, at + length);
        const ids = forms.get(slice);
        if (ids) {
          tokens.push({
            text: slice,
            start: at,
            end: at + length,
            kind: 'word',
            entryIds: [...ids],
            via: 'entry',
          });
          taken = length;
          break;
        }
      }
      if (taken === 0) {
        // A character no declared entry covers. `via: 'fallback'` is what
        // `ground()` reads to say "the dictionary does not have this".
        tokens.push({
          text: text[at] ?? '',
          start: at,
          end: at + 1,
          kind: 'word',
          entryIds: [],
          via: 'fallback',
        });
        taken = 1;
      }
      at += taken;
    }
    return tokens;
  };

  const groupsFor = (matches: readonly Entry[]): SearchGroup[] => {
    const byHeadword = new Map<string, Entry[]>();
    for (const entry of matches) {
      const key = `${entry.trad}|${entry.simp}`;
      byHeadword.set(key, [...(byHeadword.get(key) ?? []), entry]);
    }
    return [...byHeadword].map(([key, entries]) => {
      const [head] = entries;
      return {
        key,
        simp: head?.simp ?? '',
        trad: head?.trad ?? '',
        source: 'hanzi',
        matchedIds: entries.map((entry) => entry.id),
        entries,
        ...(head?.hskBand === undefined ? {} : { hskBand: head.hskBand }),
      } satisfies SearchGroup;
    });
  };

  return {
    get status() {
      return status;
    },
    subscribe: () => () => {},
    open: async () => {},
    setEntries(entries) {
      rows = [...entries];
    },
    async entries(ids) {
      options.onEntries?.(ids);
      const map = byId();
      return ids.flatMap((id) => {
        const entry = map.get(id);
        return entry ? [entry] : [];
      });
    },
    async search(query, searchOptions): Promise<SearchResult> {
      const needle = query.trim();
      const matched = rows.filter(
        (entry) =>
          entry.simp === needle ||
          entry.trad === needle ||
          entry.simp.includes(needle) ||
          entry.glosses.some((gloss) => gloss.toLowerCase().includes(needle.toLowerCase())),
      );
      const groups = groupsFor(matched).slice(0, searchOptions?.limit ?? 50);
      return {
        query: needle,
        route: 'hanzi',
        groups,
        sections: groups.length > 0 ? [{ source: 'hanzi', label: 'Hanzi', groups }] : [],
        total: groups.length,
        dictVersion: status.state === 'ready' ? status.version : '',
        offset: 0,
      };
    },
    async segment(text): Promise<SegmentResult> {
      return { text, script: 'simp', tokens: segmentText(text) };
    },
    async hskBand(band: HskBand, bandOptions) {
      const inBand = rows.filter((entry) => entry.hskBand === band);
      const offset = bandOptions?.offset ?? 0;
      return inBand.slice(offset, bandOptions?.limit === undefined ? undefined : offset + bandOptions.limit);
    },
    async readingCount(simp) {
      return rows.filter((entry) => entry.simp === simp).length;
    },
    async wordsContaining(ch) {
      return rows.filter((entry) => entry.simp.includes(ch));
    },
  };
}
