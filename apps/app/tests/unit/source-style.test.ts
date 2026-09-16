/**
 * The source's one unwritten formatting convention, written down.
 *
 * `components/lookup/ask-panel.tsx` came back from a C8 edit reformatted by a
 * different formatter: 18 double-quoted imports and an ~80-column wrap, against
 * single quotes and ~100 columns in the other 132 files of the app. Nothing
 * pulled it back — there is no Prettier config in the repo and `pnpm lint` has
 * no quote rule — so the one substantive fix in that commit was buried in 500
 * lines of requoting, and the next edit would have either re-churned the file
 * or left it mixed. Found by C8's adversarial review.
 *
 * There is no CI (CLAUDE.md), so a rule that wants enforcement is a unit test.
 * This is the half of the convention a machine can check exactly: **a string
 * literal outside a JSX attribute is single-quoted.** JSX attributes are
 * double-quoted, as they are everywhere in the app and in the HTML they compile
 * to, and a literal whose own text contains an apostrophe is exempt — quoting it
 * the other way is what double quotes are for.
 *
 * The column width is deliberately not checked: it is a soft convention, it
 * varies across the app already, and pinning it would fail on the many lines a
 * long identifier makes unavoidable.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { appRoot, workspaceRoot } from '@/lib/server/roots';

const APP = appRoot(import.meta.dirname);
const WORKSPACE = workspaceRoot(import.meta.dirname);

/** Tracked source only: generated output and `node_modules` are nobody's style. */
function trackedSources(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--', 'apps/app/**/*.ts', 'apps/app/**/*.tsx'],
    { cwd: WORKSPACE, encoding: 'utf8' },
  );
  return out.split('\n').filter(Boolean);
}

interface Offence {
  file: string;
  line: number;
  text: string;
}

function doubleQuoted(file: string): Offence[] {
  const text = readFileSync(resolve(WORKSPACE, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Offence[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteral(node)) {
      const raw = text.slice(node.getStart(source), node.getEnd());
      const exempt = ts.isJsxAttribute(node.parent) || node.text.includes("'");
      if (!exempt && raw.startsWith('"')) {
        found.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          text: raw.slice(0, 60),
        });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

describe('the app’s source style', () => {
  it('has sources to check, so a silent zero is not a pass', () => {
    const files = trackedSources();
    expect(files.length).toBeGreaterThan(100);
    expect(files.every((file) => file.startsWith('apps/app/'))).toBe(true);
    // The file the rule was written for.
    expect(files).toContain('apps/app/components/lookup/ask-panel.tsx');
  });

  it('single-quotes every string literal outside a JSX attribute', () => {
    const offences = trackedSources().flatMap(doubleQuoted);
    expect(
      offences.map((offence) => `${offence.file}:${offence.line} ${offence.text}`),
    ).toEqual([]);
  });

  it('double-quotes JSX attributes, which is the other half of the same rule', () => {
    // Asserted against a file that is full of them rather than by a second
    // sweep: the point is that the exemption above is a convention, not a hole.
    const file = resolve(APP, 'components/lookup/ask-panel.tsx');
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let attributes = 0;
    let singleQuoted = 0;
    const walk = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
        attributes += 1;
        if (text.slice(node.initializer.getStart(source), node.initializer.getEnd()).startsWith("'"))
          singleQuoted += 1;
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    expect(attributes).toBeGreaterThan(20);
    expect(singleQuoted).toBe(0);
  });
});
