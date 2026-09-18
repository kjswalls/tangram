/**
 * The registry, checked (docs/plans/web.md W8, criterion 1).
 *
 * W8's first acceptance criterion is two assertions over the table: **no two
 * bindings share a key combination in the same scope**, and **every binding has
 * a human-readable description** — "the help sheet is generated, so an
 * undescribed binding is a bug".
 *
 * Both are here, and both are written to fail loudly rather than vacuously: a
 * collision test over an empty table passes, so the first case is that the
 * table is not empty and the last is that the help sheet really is generated
 * from it rather than from a second hand-written list.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BINDINGS,
  SCOPES,
  bindingsForScope,
  comboId,
  formatCombo,
  parseCombo,
  type ScopeId,
} from '@/src/keys/registry';
import { matchesCombo } from '@/src/keys/use-shortcuts';

const appRoot = join(import.meta.dirname, '..', '..', '..');

/** The keystroke a combination describes, as a matcher would see it. */
function eventFor(combo: { key: string; mod: boolean; alt: boolean; shift: boolean }): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: combo.key,
    ctrlKey: combo.mod,
    altKey: combo.alt,
    // A one-character key carries its own shift state in the character, so the
    // flag only matters for a named one.
    shiftKey: combo.shift || (combo.key.length === 1 && combo.key !== combo.key.toLowerCase()),
  });
}

describe('the shortcut registry', () => {
  it('has bindings in it, and every one names a scope that exists', () => {
    // Without this the two criteria below pass against an empty table, which is
    // the shape of vacuous test this repository has shipped twice.
    expect(BINDINGS.length).toBeGreaterThanOrEqual(5);
    for (const binding of BINDINGS) {
      expect(SCOPES[binding.scope], binding.id).toBeDefined();
      expect(binding.keys.length, binding.id).toBeGreaterThan(0);
    }
  });

  it('gives every binding a unique id', () => {
    const ids = BINDINGS.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /** Criterion 1, first half. */
  it('never lets two bindings in one scope share a key combination', () => {
    for (const scope of Object.keys(SCOPES) as ScopeId[]) {
      const seen = new Map<string, string>();
      for (const binding of bindingsForScope(scope)) {
        for (const spec of binding.keys) {
          const id = comboId(parseCombo(spec));
          const owner = seen.get(id);
          expect(
            owner,
            `${scope}: ${id} is claimed by both ${owner} and ${binding.id}`,
          ).toBeUndefined();
          seen.set(id, binding.id);
        }
      }
    }
  });

  /**
   * Not W8's criterion, and worth asserting anyway.
   *
   * `use-shortcuts.ts` answers a cross-scope duplicate by shadowing — the most
   * specific live scope wins and the key stops there — so a duplicate is
   * *defined* rather than broken. This case says the shipped table has none, so
   * that nobody has to reason about shadowing to predict what a key does today.
   * The dispatcher's own tests cover the rule itself.
   */
  it('and no two scopes claim the same combination either, today', () => {
    const seen = new Map<string, string>();
    for (const binding of BINDINGS) {
      for (const spec of binding.keys) {
        const id = comboId(parseCombo(spec));
        const owner = seen.get(id);
        expect(owner, `${id} is claimed by both ${owner} and ${binding.id}`).toBeUndefined();
        seen.set(id, binding.id);
      }
    }
  });

  /** Criterion 1, second half. */
  it('describes every binding in words a help sheet can print', () => {
    for (const binding of BINDINGS) {
      expect(binding.description, binding.id).toBeTruthy();
      expect(binding.description.trim(), binding.id).toBe(binding.description);
      expect(binding.description.length, binding.id).toBeGreaterThan(3);
      // A description is a sentence about what happens, not a restatement of
      // the key. "Press ⌘K" in the "⌘K" row is a row that says nothing.
      expect(binding.description, binding.id).not.toMatch(/^(press|hit|type)\b/i);
    }
  });

  it('says whose binding each one is', () => {
    for (const binding of BINDINGS) {
      expect(['product', 'plan', 'core'], binding.id).toContain(binding.source);
    }
    // W8 asks that the two sources be kept apart; product-decisions §10's only
    // palette-free binding is Mod+K, so at least one row must carry its name.
    expect(BINDINGS.some((binding) => binding.source === 'product')).toBe(true);
  });

  it('declares no palette — `wave-zero.md` §10c ships it with the desktop app', () => {
    // W8b is not this phase. If a palette scope appears here without C9, the
    // phase boundary has been crossed by accident rather than by decision.
    // `dialog` is not a palette: it declares no bindings and exists only to
    // block the scopes underneath an open modal sheet.
    expect(Object.keys(SCOPES).sort()).toEqual(['app', 'dialog', 'review']);
    expect(bindingsForScope('dialog')).toEqual([]);
    expect(SCOPES.dialog.blocking).toBe(true);
  });

  /**
   * Criterion 1, checked against what actually *fires* rather than against the
   * canonical id.
   *
   * The adversarial review found the hole: `comboId` treats `?` and `Shift+?`
   * as two different combinations, while `matchesCombo` deliberately ignores
   * `shiftKey` for a one-character key (see `Combo.shift` — the character
   * already encodes its own shift state). So a pair like that would pass the
   * id-based case above and still both fire on one keystroke, which is the
   * exact class of bug the criterion exists to catch. This case asks the
   * matcher instead: for every combination in the table, no two bindings in a
   * scope may answer the same synthesized event.
   */
  it('…and no two bindings in one scope answer the same keystroke', () => {
    const events = BINDINGS.flatMap((binding) =>
      binding.keys.map((spec) => ({ spec, event: eventFor(parseCombo(spec)) })),
    );
    for (const scope of Object.keys(SCOPES) as ScopeId[]) {
      for (const { spec, event } of events) {
        const claimants = bindingsForScope(scope).filter((binding) =>
          binding.keys.some((candidate) => matchesCombo(parseCombo(candidate), event, false)),
        );
        expect(
          claimants.length,
          `${scope}: ${spec} is answered by ${claimants.map((b) => b.id).join(', ')}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('generates the help sheet from the table rather than from a second list', () => {
    const sheet = readFileSync(join(appRoot, 'src', 'keys', 'shortcut-help.tsx'), 'utf8');
    for (const binding of BINDINGS) {
      // The descriptions and the key names must not be spelled again in the
      // component — it maps over BINDINGS, so finding one there means somebody
      // started a parallel copy.
      expect(sheet, binding.id).not.toContain(binding.description);
    }
    expect(sheet).toContain('BINDINGS.filter');
  });
});

describe('parseCombo', () => {
  it('reads modifiers and normalises the key', () => {
    expect(parseCombo('Mod+K')).toEqual({ key: 'k', mod: true, alt: false, shift: false });
    expect(parseCombo('Space')).toEqual({ key: ' ', mod: false, alt: false, shift: false });
    expect(parseCombo('Escape')).toEqual({ key: 'Escape', mod: false, alt: false, shift: false });
    expect(parseCombo('Shift+Tab')).toEqual({ key: 'Tab', mod: false, alt: false, shift: true });
    expect(parseCombo('?')).toEqual({ key: '?', mod: false, alt: false, shift: false });
    expect(parseCombo('Down')).toEqual({
      key: 'ArrowDown',
      mod: false,
      alt: false,
      shift: false,
    });
  });

  it('refuses a modifier it does not know, rather than dropping it silently', () => {
    // `Cmd+K` and `Ctrl+K` are the two spellings somebody will reach for, and
    // both would otherwise parse as a bare `K` that fires on every keystroke.
    expect(() => parseCombo('Cmd+K')).toThrow(/unknown modifier/);
    expect(() => parseCombo('Ctrl+K')).toThrow(/unknown modifier/);
  });

  it('round-trips through comboId', () => {
    for (const spec of ['Mod+K', '/', '?', 'Space', 'Shift+Tab', '1']) {
      expect(comboId(parseCombo(comboId(parseCombo(spec))))).toBe(comboId(parseCombo(spec)));
    }
  });
});

describe('formatCombo', () => {
  it('spells the modifier the way the platform does', () => {
    expect(formatCombo('Mod+K', true)).toBe('⌘K');
    expect(formatCombo('Mod+K', false)).toBe('Ctrl+K');
  });

  it('names Space rather than printing nothing', () => {
    expect(formatCombo('Space', false)).toBe('Space');
  });

  it('leaves a bare character alone', () => {
    expect(formatCombo('?', false)).toBe('?');
    expect(formatCombo('1', false)).toBe('1');
  });
});
