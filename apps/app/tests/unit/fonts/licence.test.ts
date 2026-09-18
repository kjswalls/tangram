/**
 * The OFL, as a check rather than a sentence (docs/plans/web.md W6; CLAUDE.md,
 * "Data and licences").
 *
 * **W6 is the phase that starts redistributing font software.** Before it,
 * `vendor/fonts/` was a measurement input: gitignored binaries, fetched to be
 * read by `pnpm font:coverage`, never served to anyone. Now every visitor
 * downloads a subset of four OFL families, and three obligations attach to that
 * which did not attach to measuring:
 *
 *   - **Clause 2** — each copy must carry the copyright notice *and* the
 *     licence. The notice rides inside each `.woff2`'s `name` table (harfbuzz
 *     preserves it), and the licence is reproduced in `data/ATTRIBUTION.md`,
 *     which the Library tab renders. The per-family `OFL.txt` files under
 *     `vendor/fonts` do not satisfy this on their own: `vendor` is not deployed.
 *   - **Clause 3** — a Modified Version may not use a Reserved Font Name, and a
 *     subset is a Modified Version. Noto Sans SC's is `Source`.
 *   - **Clause 5** — the whole of it stays under the OFL. Nothing here changes
 *     that; it is why no shipped file is re-licensed or re-named.
 *
 * Each assertion below is one of those, read off the shipped bytes and the
 * shipped text rather than off this comment.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { create as createFont, type Font } from 'fontkit';
import { describe, expect, it } from 'vitest';

import { appRoot, dirOf, workspaceRoot } from '@/lib/server/roots';

const here = dirOf(import.meta.url);
const root = workspaceRoot(here);
const app = appRoot(here);

const attribution = () => readFileSync(join(root, 'data', 'ATTRIBUTION.md'), 'utf8');
const shipped = () =>
  readdirSync(join(app, 'src', 'fonts'))
    .filter((name) => name.endsWith('.woff2'))
    .map((name) => join(app, 'src', 'fonts', name));

describe('the shipped subsets satisfy the OFL', () => {
  it('every shipped file keeps its upstream copyright notice', () => {
    const files = shipped();
    expect(files.length, 'no fonts are built — run `pnpm font:subset`').toBeGreaterThan(0);
    for (const path of files) {
      const font = createFont(readFileSync(path)) as Font & { copyright?: string };
      expect(font.copyright ?? '', path).toMatch(/copyright|\(c\)|©/i);
    }
  });

  it('no shipped file uses a Reserved Font Name', () => {
    // The only RFN among the four families: Noto Sans SC's, from its Adobe
    // Source Han ancestry. A subset that carried `Source` in its primary name
    // would need written permission from the copyright holder.
    const reserved = ['Source'];
    for (const path of shipped()) {
      const font = createFont(readFileSync(path)) as Font & {
        familyName?: string;
        fullName?: string;
        postscriptName?: string;
      };
      const names = [font.familyName, font.fullName, font.postscriptName].filter(
        (value): value is string => typeof value === 'string',
      );
      expect(names.length, path).toBeGreaterThan(0);
      for (const name of names) {
        for (const word of reserved) expect(name, `${path} → ${name}`).not.toContain(word);
      }
    }
  });

  /**
   * The licence has to reach the learner, not just the repository.
   * `data/ATTRIBUTION.md` is what the Library tab renders (`?raw` at build
   * time), so it is the only text this app actually distributes.
   */
  it('ATTRIBUTION.md carries the OFL text and every family it ships', async () => {
    const text = attribution();
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
    // The clauses that bind this repo, so a future trim cannot quietly drop them.
    expect(text).toContain('No Modified Version of the Font Software may use the');
    expect(text).toContain('must be distributed entirely under this license');

    const { SHIPPED } = (await import(
      /* @vite-ignore */ join(root, 'scripts', 'font-shipping.ts')
    )) as typeof import('../../../../../scripts/font-shipping');
    const families = new Set(SHIPPED.map((family) => family.family));
    for (const family of SHIPPED) if (family.donor) families.add(family.donor);
    for (const family of families) {
      expect(text, `${family} is shipped but not named in data/ATTRIBUTION.md`).toContain(family);
    }
  });

  it('the vendored licence files are still committed beside their binaries', () => {
    // C0's half of the same obligation, for the originals rather than the cut
    // copies. `.gitignore` keeps the binaries out and the `.txt` files in; a
    // rule that swallowed the licence would be a licence bug, not tidiness.
    for (const dir of readdirSync(join(root, 'vendor', 'fonts'))) {
      expect(existsSync(join(root, 'vendor', 'fonts', dir, 'OFL.txt')), dir).toBe(true);
    }
  });
});
