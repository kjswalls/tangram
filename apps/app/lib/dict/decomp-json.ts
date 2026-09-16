/**
 * `decomp.json` on the web (docs/plans/data.md D4).
 */
import { assetUrl } from './asset-url';
import type { DecompCharacter, DecompStore } from './decomp-store';
import type { DecompFile } from './types';

/**
 * The web implementation: `decomp.json`, fetched once, lazily
 * (docs/plans/data.md D4).
 *
 * Three properties, all of them deliberate:
 *
 *  - **Lazy.** 0.92 MB is not first-load budget. Nothing is fetched until a
 *    character sheet actually asks for a decomposition, which D4 criterion 8
 *    asserts against the network log. A missing decomposition is a degraded
 *    panel, not a broken app.
 *  - **Once.** The in-flight promise is shared, so three characters opened in
 *    the same frame make one request rather than three.
 *  - **Separate from the dictionary, because the licences differ.** Make Me a
 *    Hanzi is LGPL-3.0-or-later and CC-CEDICT is CC BY-SA 4.0; this data never
 *    enters the `.sqlite`, a card snapshot or a model prompt (CLAUDE.md, "Data
 *    and licences"; PLAN.md §5). One object holding both would invite one query
 *    with both in the answer.
 *
 * `web.md` W2 serves it at `/decomp.json`, not content-addressed and not
 * immutable. W2's text says it is "picked up by the service worker's runtime
 * cache rather than precached"; **it is not, and cannot be with the worker as it
 * stands** — `scripts/sw.template.js` calls `respondWith` only for
 * `/assets/**` and for navigations, and a root-level `/decomp.json` matches
 * neither. So today it is re-fetched once per page that opens a character sheet
 * and a character sheet does not work offline. That is a degraded panel rather
 * than a broken app, which is the rule this file is written to, and it is
 * `web.md` W2/W3's to close: one `url.pathname === '/decomp.json'` rule in the
 * worker. Recorded in HANDOFF.md under D4.
 *
 * **Its own module, and `data.md` D4's Files list is wrong about that.** D4 puts
 * this implementation in `lib/dict/decomp-store.ts`; D1 froze that file as types
 * only and `tests/unit/dict/store-contract.test.ts` asserts it emits nothing at
 * runtime — "the day someone adds a function to one of these three modules this
 * fails, which is the point". The test is right and the Files list is a slip, so
 * the interface stays where it was frozen and the implementation lands here,
 * beside `sqlite-store.ts` and `http-store.ts`.
 */
export const DEFAULT_DECOMP_URL = assetUrl('decomp.json');

export class JsonDecompStore implements DecompStore {
  readonly #url: string;
  #loading: Promise<DecompFile> | undefined;

  constructor(options: { url?: string } = {}) {
    this.#url = options.url ?? DEFAULT_DECOMP_URL;
  }

  /** Whether the file has been asked for yet. The laziness criterion reads this. */
  get fetched(): boolean {
    return this.#loading !== undefined;
  }

  #load(): Promise<DecompFile> {
    this.#loading ??= (async () => {
      const response = await fetch(this.#url, { credentials: 'same-origin' });
      if (!response.ok) {
        throw new Error(`decomposition data answered ${response.status}`);
      }
      return (await response.json()) as DecompFile;
    })().catch((error: unknown) => {
      // Do not latch the failure: an offline first tap must not mean no
      // decomposition for the rest of the session.
      this.#loading = undefined;
      throw error;
    });
    return this.#loading;
  }

  async decompose(chars: string): Promise<DecompCharacter[]> {
    const file = await this.#load();
    const seen = new Set<string>();
    const out: DecompCharacter[] = [];
    for (const char of chars) {
      if (seen.has(char)) continue;
      seen.add(char);
      out.push({ char, entry: file[char] ?? null });
    }
    return out;
  }
}
