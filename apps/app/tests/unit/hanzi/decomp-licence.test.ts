/**
 * The licence boundary, asserted rather than assumed (docs/plans/core.md C4;
 * CLAUDE.md "Data and licences"; PLAN.md §5).
 *
 * `data/decomp.json` is **Make Me a Hanzi, LGPL-3.0-or-later**. The dictionary
 * is CC-CEDICT, CC BY-SA 4.0. They are kept apart deliberately and the rule is
 * absolute: decomposition data is *displayed* and **never** enters a card
 * snapshot, the SQLite dictionary or a model prompt. C4's character sheet is
 * the only screen in the app that renders both at once, and it is therefore
 * the only place that could break it — a snapshot builder that took "whatever
 * the sheet had" would relicense every card the learner owns.
 *
 * Two assertions, because the rule has two halves:
 *
 *  1. **By shape.** `EntrySnapshot` has no field a `DecompEntry` could occupy,
 *     and `toEntrySnapshot` copies named fields off an `Entry` rather than
 *     spreading an object — so no caller can smuggle one in by passing a
 *     widened object. Checked against the *output*, not the type, because the
 *     type is erased at runtime and a spread would type-check.
 *  2. **By name.** Nothing under `lib/db/**` so much as names a decomposition
 *     type or field. The first version of this checked only for imports from
 *     `lib/dict/decomp*` — which was worse than useless, because `DecompEntry`
 *     is declared in `lib/types.ts` and every file under `lib/db` already
 *     imports from there, so the guarantee the comment claimed did not exist.
 *     Naming is the check that does hold: a snapshot builder that writes a
 *     decomposition has to say `decomposition`, `radical` or `DecompEntry`
 *     somewhere.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { toEntrySnapshot } from '@/lib/db/dexie';
import type { DecompEntry, Entry } from '@/lib/types';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every field name a `DecompEntry` carries. */
const DECOMP_FIELDS: (keyof DecompEntry)[] = ['decomposition', 'radical', 'definition'];

const DA: Entry = {
  id: '打算|打算[da3 suan4]',
  simp: '打算',
  trad: '打算',
  pinyinNum: 'da3 suan4',
  pinyinMarked: 'dǎsuàn',
  glosses: ['to plan'],
  classifiers: ['个'],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 2,
};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('the decomposition licence boundary', () => {
  it('a card snapshot carries no DecompEntry field, even when one is handed in', () => {
    // A caller that had both in scope and got careless: the widened object
    // type-checks as an `Entry` and carries the decomposition alongside it.
    const contaminated = {
      ...DA,
      decomposition: '⿰扌丁',
      radical: '扌',
      definition: 'hand',
    } as Entry;

    const snapshot = toEntrySnapshot(contaminated, 'test') as unknown as Record<string, unknown>;
    for (const field of DECOMP_FIELDS) {
      expect(snapshot, `${field} reached a card snapshot`).not.toHaveProperty(field);
    }
    // Not vacuous: the dictionary's own fields did survive the copy.
    expect(snapshot.simp).toBe('打算');
    expect(snapshot.glosses).toEqual(['to plan']);
  });

  it('nothing under lib/db names a decomposition type or field', () => {
    // Comments are stripped first: this file's own siblings talk about the rule
    // in prose, and a rule that cannot be discussed is a rule nobody keeps.
    const named = /\b(DecompEntry|DecompCharacter|DecompFile|decomposition|radical)\b/;
    const offenders = files(join(appRoot, 'lib', 'db')).filter((path) => {
      const code = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return named.test(code);
    });
    expect(offenders).toEqual([]);
  });

});

