/**
 * Character decomposition, kept apart from the dictionary (docs/plans/data.md D1).
 *
 * Two interfaces because two licences. `decomp.json` is Make Me a Hanzi,
 * LGPL-3.0-or-later; the SQLite dictionary is CC-CEDICT, CC BY-SA 4.0. The
 * decomposition data never enters the `.sqlite`, a card snapshot or a model
 * prompt (CLAUDE.md, "Data and licences"; PLAN.md §5), and one object with both
 * on it would invite one query with both in the answer.
 *
 * **Frozen by D1's first commit**, alongside `store.ts` and `sql.ts`.
 */
import type { DecompEntry } from './types';

/** One requested character and what is known about it. `entry` is null when nothing is. */
export interface DecompCharacter {
  char: string;
  entry: DecompEntry | null;
}

export interface DecompStore {
  /** Decomposition for each character of `chars`, deduplicated, in order. */
  decompose(chars: string): Promise<DecompCharacter[]>;
}
