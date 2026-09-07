/**
 * Character decomposition for the lookup panel (PLAN.md §3.1).
 *
 * `data/decomp.json` is Make Me a Hanzi, LGPL-3.0-or-later, and the whole reason
 * it is a second file is that its licence differs from CC-CEDICT's. It is read
 * here, rendered in the panel, and it **never** enters a card snapshot, a prompt
 * or `dict.json` (CLAUDE.md, "Data and licences").
 */
import { getDecomp } from './load';
import type { DecompEntry } from './types';

export interface DecompResponse {
  /** One entry per requested character, in order. `entry` is null when unknown. */
  characters: { char: string; entry: DecompEntry | null }[];
}

/** Decomposition for each character of `text`, deduplicated, in order. */
export function decomposeChars(text: string): DecompResponse['characters'] {
  const decomp = getDecomp();
  const seen = new Set<string>();
  const out: DecompResponse['characters'] = [];
  for (const char of text) {
    if (seen.has(char)) continue;
    seen.add(char);
    out.push({ char, entry: decomp[char] ?? null });
  }
  return out;
}
