/**
 * WCAG AA for every text pairing the app uses, computed from app/tokens.css.
 *
 * The first-run audit (HANDOFF.md, 2026-09-23) found three settled pairs under
 * 4.5:1 on every screen — `--muted` on `--paper`, `--lookup` on
 * `--lookup-soft`, `--new` on `--new-soft` — and muted text on every soft
 * tint. They had been measured by C0 and C1 and printed as FAIL in /gallery for
 * months, and nothing failed a build. This is the build failure.
 *
 * The pairs are `/gallery`'s own `CONTRAST_PAIRS`, so the table a reviewer
 * looks at and the list this test holds are one list. Both palettes: the light
 * one on bare `:root`, and the dark one as `[data-theme='dark']` resolves it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONTRAST_PAIRS } from '@/components/gallery/gallery';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const css = readFileSync(join(appRoot, 'app', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations of the first block whose selector matches, brace-balanced. */
function block(selector: RegExp): Record<string, string> {
  const match = selector.exec(css);
  if (!match) throw new Error(`no block for ${selector}`);
  const open = css.indexOf('{', match.index);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const out: Record<string, string> = {};
  for (const line of css.slice(open + 1, end).split(';')) {
    const decl = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(line);
    if (decl) out[decl[1]] = decl[2].trim();
  }
  return out;
}

const light = block(/(?:^|[};])\s*:root\s*\{/m);
const dark = { ...light, ...block(/:root\[data-theme='dark'\]\s*\{/) };

function hex(name: string, scope: Record<string, string>): string {
  let value = scope[name];
  for (let i = 0; i < 10 && value !== undefined; i += 1) {
    const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value);
    if (!ref) break;
    value = scope[ref[1]];
  }
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} → ${String(value)}`);
  return value;
}

function luminance(colour: string): number {
  const channel = (i: number) => {
    const c = parseInt(colour.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function ratio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// The skeleton is a placeholder shape, not text and not a control: WCAG sets no
// contrast floor for it, and its row in the table is a legibility note.
const TEXT_PAIRS = CONTRAST_PAIRS.filter((pair) => pair.fg !== '--skeleton');

describe('every text pairing clears WCAG AA', () => {
  for (const [name, scope] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it.each(TEXT_PAIRS.map((pair) => [pair.fg, pair.bg, pair.use, pair.large ?? false] as const))(
      `${name}: %s on %s (%s)`,
      (fg, bg, _use, large) => {
        const value = ratio(hex(fg, scope), hex(bg, scope));
        expect(value).toBeGreaterThanOrEqual(large ? 3 : 4.5);
      },
    );
  }

  it('the table covers muted text on every soft tint', () => {
    // Muted-on-tint is the pairing that has no row until someone thinks of it,
    // and the one the audit found on the picked search result.
    for (const tint of ['--lookup-soft', '--new-soft', '--practice-soft', '--warning-soft']) {
      expect(TEXT_PAIRS.some((pair) => pair.fg === '--muted-on-tint' && pair.bg === tint), tint).toBe(true);
    }
  });

  it('text dimmed with opacity on a filled button still clears AA', () => {
    // The grade buttons' interval ("10m") was `opacity-80` on vermillion —
    // 4.13:1 — and the key number beside each label `opacity-60`. Both sit on
    // the primary (vermillion) grade button, and either can sit on a jade one.
    const dimmed = [
      ['components/ui/button.tsx', /opacity-(\d+)">\{sub\}/],
      ['components/review/grade-bar.tsx', /opacity-(\d+)">\s*\{option\.rating\}/],
    ] as const;
    for (const [file, marker] of dimmed) {
      const opacity = marker.exec(readFileSync(join(appRoot, file), 'utf8'));
      expect(opacity, file).not.toBeNull();
      const alpha = Number(opacity![1]) / 100;
      for (const [name, scope] of [
        ['light', light],
        ['dark', dark],
      ] as const) {
        for (const accent of ['--practice', '--lookup']) {
          const fg = hex('--on-accent', scope);
          const bg = hex(accent, scope);
          const mixed =
            '#' +
            [1, 3, 5]
              .map((i) => {
                const f = parseInt(fg.slice(i, i + 2), 16);
                const b = parseInt(bg.slice(i, i + 2), 16);
                return Math.round(f * alpha + b * (1 - alpha))
                  .toString(16)
                  .padStart(2, '0');
              })
              .join('');
          expect(ratio(mixed, bg), `${file} ${name} on ${accent}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('inside a tinted element, muted text is re-pointed at --muted-on-tint', () => {
    const rule = /:where\(([^)]*)\)\s*\{\s*--muted:\s*var\(--muted-on-tint\)/.exec(css);
    expect(rule, 'the tint rule in tokens.css').not.toBeNull();
    for (const utility of ['.bg-lookup-soft', '.bg-accent-soft', '.bg-new-soft', '.bg-practice-soft', '.bg-warning-soft']) {
      expect(rule![1]).toContain(utility);
    }
  });
});
