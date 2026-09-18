/**
 * The keyboard model, as declared data (docs/plans/web.md W8).
 *
 * **Bindings are rows in a table, not handlers scattered through components**,
 * for the three reasons W8 gives: the help sheet is generated from this table,
 * a test can assert that no two bindings collide, and the palette that
 * `core.md` C9 may one day bring reuses the same table instead of growing a
 * second key system. `wave-zero.md` §10c defers that palette with the desktop
 * application, so **nothing here declares one** — what is here is the scope
 * mechanism it will plug into.
 *
 * ## Scope is a property of the binding, never an `if` inside a handler
 *
 * W8's rule 1: *a binding without a modifier never fires while focus is in a
 * text input — except inside the palette's own input.* Written as a condition
 * in each handler it is a rule that holds until somebody forgets it once, and
 * the symptom is the worst kind: typing 中 into the lookup box navigates. So it
 * is not a condition at all. Every binding names a scope, every scope declares
 * `firesWhileTyping`, and `use-shortcuts.ts` is the one place that consults
 * either. A binding *with* a modifier is exempt because `Mod+K` is not a
 * character anybody can type into a box.
 *
 * ## Whose bindings these are
 *
 * W8 asks that the two sources be kept apart, so `source` says which:
 *
 * - `'product'` — product-decisions §10 asked for it. Of its four, only
 *   **Mod+K** ("the slim bar during a practice session, and by extension
 *   summoning the palette") exists without a palette; `Enter`, `Mod+Enter` and
 *   `Tab` are all palette-input bindings and arrive with W8b.
 * - `'plan'` — `web.md` W8's own additions, required by its two rules and by
 *   the keyboard-only acceptance criterion.
 * - `'core'` — bindings that already existed as hand-written listeners and have
 *   been moved here rather than left scattered. The practice session's six are
 *   the whole of that set.
 *
 * ## What a browser cannot do
 *
 * `Mod+K` works only when the app already has focus. There is no global hotkey
 * in any browser (Chromium issue 40749250; STACK §2.4), so nothing in this file
 * can summon anything. Summoning arrives with Tauri or not at all.
 */

/**
 * A scope is a *surface*, and at most one instance of each is live at a time.
 *
 * `'app'` is always live. `'review'` is live while the practice session has a
 * card on screen. `'dialog'` is live while a modal sheet is open and declares no
 * bindings at all — it exists to *stop* the ones underneath it, which is what
 * `blocking` is for. A palette would add a fourth with
 * `overridesFocusedElement: true`, which is the only reason that field is a
 * field rather than a constant.
 */
export type ScopeId = 'app' | 'review' | 'dialog';

export interface ShortcutScope {
  id: ScopeId;
  /** What the help sheet calls this group. */
  title: string;
  /**
   * Whether an **unmodified** binding in this scope fires even when the focused
   * element already owns that key.
   *
   * Two elements own keys: a text input owns every printable character (W8
   * rule 1 — otherwise typing 中 into the lookup box navigates), and a link or
   * a button owns **Enter and Space**, because those are how a keyboard user
   * presses it. The second half was found by the adversarial review and is not
   * hypothetical: `review.reveal` binds Enter, so with this `false` and no such
   * rule, pressing Enter on the Library tab link revealed the card instead of
   * changing tabs — a keyboard-only learner could not leave the Practice tab
   * while a card was face down.
   *
   * `false` everywhere today. The palette's scope is the exception the rule
   * names — its input owns arrows, Enter and Escape by design, and its rows are
   * not buttons — so when C9 lands it registers a scope with this set `true`
   * and nothing else in the mechanism changes.
   */
  overridesFocusedElement: boolean;
  /**
   * Higher wins when two live scopes declare the same combination.
   *
   * The shipped table has no such pair and a test says so, but the dispatcher
   * has to answer the question *somehow*, and "the most specific live surface
   * wins, and the key event stops there" is the answer that does not depend on
   * declaration order. A palette would sit above both.
   */
  priority: number;
  /**
   * While this scope is live, a key it does not claim reaches **nothing**
   * underneath it.
   *
   * Only `'dialog'` sets it, and it is the whole of that scope. A modal sheet
   * is modal: the review session must not grade a card the learner cannot see
   * because it is behind the shortcuts sheet, and `/` must not navigate out
   * from under an open dialog and leave it stranded with its Escape handler on
   * an element focus has left. Both were found by the adversarial review, both
   * reproduced.
   */
  blocking?: boolean;
}

export const SCOPES: Record<ScopeId, ShortcutScope> = {
  app: { id: 'app', title: 'Anywhere', overridesFocusedElement: false, priority: 0 },
  review: {
    id: 'review',
    title: 'While practising',
    overridesFocusedElement: false,
    priority: 10,
  },
  /**
   * No bindings, no title anybody reads: a modal sheet is a wall, and this is
   * the wall. `shortcut-help.tsx` lists the scopes it wants by name rather than
   * everything in `SCOPES`, so nothing tries to print an empty section.
   */
  dialog: {
    id: 'dialog',
    title: 'While a sheet is open',
    overridesFocusedElement: false,
    priority: 100,
    blocking: true,
  },
};

export type BindingSource = 'product' | 'plan' | 'core';

export interface Binding {
  /** Stable id. A screen attaches a handler by it; never shown to a learner. */
  id: string;
  scope: ScopeId;
  /**
   * One or more key combinations, written as `Mod+K`, `Shift+Tab`, `Space`,
   * `Escape`, `?`, `1`. `Mod` is ⌘ on Apple and Ctrl everywhere else.
   *
   * Several combinations mean several ways to do one thing (Space *or* Enter
   * reveals a card), not several things.
   */
  keys: readonly string[];
  /**
   * Human-readable, imperative, lower case after the first word.
   *
   * **The help sheet is generated from this table**, so a binding without a
   * description is a binding nobody can discover — which is why
   * `tests/unit/keys/registry.test.ts` fails on an empty one rather than
   * leaving it to a reviewer.
   */
  description: string;
  source: BindingSource;
}

/**
 * The table.
 *
 * Deliberately short. Every row here is either something that already existed
 * as a listener, or something W8's own acceptance criteria require; nothing is
 * here because it seemed like a nice shortcut to have.
 *
 * **There are no tab-jump bindings, on purpose.** W8a's keyboard-only criterion
 * is "reach every tab and every primary action", and the tabs are real links in
 * a real tab order: Tab and Enter reach them, which is the accessible answer
 * and the one a screen-reader user already knows. Inventing `g l` chords would
 * have added a key system to pass a test that the DOM already passes.
 */
export const BINDINGS: readonly Binding[] = [
  {
    id: 'lookup.focus',
    scope: 'app',
    keys: ['Mod+K', '/'],
    description: 'Jump to the lookup box',
    source: 'product',
  },
  {
    id: 'help.show',
    scope: 'app',
    keys: ['?'],
    description: 'Show these keyboard shortcuts',
    source: 'plan',
  },
  {
    id: 'review.reveal',
    scope: 'review',
    keys: ['Space', 'Enter'],
    description: 'Show the answer',
    source: 'core',
  },
  { id: 'review.grade.1', scope: 'review', keys: ['1'], description: 'Again', source: 'core' },
  { id: 'review.grade.2', scope: 'review', keys: ['2'], description: 'Hard', source: 'core' },
  { id: 'review.grade.3', scope: 'review', keys: ['3'], description: 'Good', source: 'core' },
  { id: 'review.grade.4', scope: 'review', keys: ['4'], description: 'Easy', source: 'core' },
];

/** One key combination, parsed. */
export interface Combo {
  /**
   * Normalised `KeyboardEvent.key`: single characters lower-cased, named keys
   * in their canonical spelling (`Enter`, `Escape`, `ArrowDown`, `Tab`, and
   * `' '` for Space).
   */
  key: string;
  /** ⌘ on Apple, Ctrl elsewhere — matched as either, so one table covers both. */
  mod: boolean;
  alt: boolean;
  /**
   * Only ever set by an explicit `Shift+` on a **named** key.
   *
   * A printable character already encodes its own shift state: `?` arrives as
   * `key: '?'` with `shiftKey: true` on a US layout and as something else
   * entirely on layouts where it is unshifted. Demanding `shiftKey === false`
   * for `'?'` would therefore match nothing, and demanding `true` would break
   * every keyboard that disagrees with a US one. So for a one-character key the
   * character *is* the assertion and `shiftKey` is not consulted.
   */
  shift: boolean;
}

const NAMED: Record<string, string> = {
  space: ' ',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  tab: 'Tab',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
};

export function parseCombo(spec: string): Combo {
  const parts = spec.split('+').map((part) => part.trim());
  // `Mod++` and `Mod+/` — a trailing empty part means the key itself was `+`.
  const raw = parts.pop() ?? '';
  const key = raw === '' ? '+' : (NAMED[raw.toLowerCase()] ?? (raw.length === 1 ? raw.toLowerCase() : raw));
  const modifiers = parts.map((part) => part.toLowerCase()).filter((part) => part !== '');
  const unknown = modifiers.filter((part) => !['mod', 'alt', 'shift'].includes(part));
  if (unknown.length > 0) throw new Error(`unknown modifier in "${spec}": ${unknown.join(', ')}`);
  return {
    key,
    mod: modifiers.includes('mod'),
    alt: modifiers.includes('alt'),
    shift: modifiers.includes('shift'),
  };
}

/**
 * The canonical form two bindings are compared by, and a valid spec itself.
 *
 * Space comes back as `Space` rather than as the literal it parses to: a `' '`
 * in a `+`-separated string is a key nothing can round-trip, and an id that
 * cannot be parsed back is an id that will be pasted into the table one day and
 * silently mean `+`.
 */
export function comboId(combo: Combo): string {
  const key = combo.key === ' ' ? 'Space' : combo.key;
  return [combo.mod ? 'Mod' : '', combo.alt ? 'Alt' : '', combo.shift ? 'Shift' : '', key]
    .filter(Boolean)
    .join('+');
}

/**
 * Whether this is an Apple platform, which decides two things.
 *
 * The help sheet spells `Mod` as ⌘ rather than Ctrl — cosmetic. And matching
 * **accepts ⌘ everywhere but accepts Ctrl only off Apple**, which is not
 * cosmetic: `Ctrl+K` is macOS's system-wide kill-to-end-of-line in every text
 * field, and a `Mod` that took either modifier on either platform quietly took
 * that away inside the lookup box and the recall box. Raised by the adversarial
 * review. An earlier version of this comment argued for taking either, on the
 * grounds that a Mac with a PC keyboard is a real thing — but that is about
 * which key is *printed* on the cap, and the Windows key is still ⌘ to macOS,
 * so the platform answer is the right one after all.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** `Mod+K` → `⌘K` or `Ctrl+K`; `Space` → `Space`. For display, never for matching. */
export function formatCombo(spec: string, apple = isApplePlatform()): string {
  const combo = parseCombo(spec);
  const key =
    combo.key === ' '
      ? 'Space'
      : combo.key.length === 1
        ? combo.key.toUpperCase()
        : combo.key;
  const parts: string[] = [];
  if (combo.mod) parts.push(apple ? '⌘' : 'Ctrl');
  if (combo.alt) parts.push(apple ? '⌥' : 'Alt');
  if (combo.shift) parts.push(apple ? '⇧' : 'Shift');
  parts.push(key);
  return apple ? parts.join('') : parts.join('+');
}

export function bindingsForScope(scope: ScopeId, bindings: readonly Binding[] = BINDINGS): Binding[] {
  return bindings.filter((binding) => binding.scope === scope);
}
