'use client';

/**
 * The one keyboard listener (docs/plans/web.md W8).
 *
 * `registry.ts` says what the bindings *are*; this says when one fires and who
 * gets told. Everything that decides — the IME guard, the text-input rule, what
 * happens when two live scopes want the same key — is in `resolveBinding`,
 * which is a pure function over an event so that it can be tested without a
 * DOM's worth of scaffolding around it.
 *
 * ## Five things it refuses to do, each of which is a bug somebody has shipped
 *
 * 1. **Fire during IME composition.** This is a Mandarin app: the lookup box is
 *    where a learner types pinyin into a Chinese IME, and every keystroke of
 *    that composition is a `keydown` whose `key` is a Latin letter. A registry
 *    that reads those is a registry that fires shortcuts while somebody spells
 *    出租车. `isComposing` is the standards-track signal and `keyCode === 229`
 *    is the older one that WebKit and some Android IMEs still use; both are
 *    checked, because the cost of checking is a boolean and the cost of missing
 *    is silent.
 * 2. **Fire an unmodified binding when the focused element already owns that
 *    key** — unless the binding's own scope says otherwise. W8 rule 1 is the
 *    first half of this (a text input owns every character, so typing 中 into
 *    the lookup box must not navigate). The second half was found by the
 *    adversarial review: a link or a button owns **Enter and Space**, because
 *    those are how a keyboard user presses it. Without it, `review.reveal`'s
 *    Enter ate the tab links while a card was face down and a keyboard-only
 *    learner could not leave the Practice tab.
 * 3. **Fire anything underneath a modal sheet.** A scope may declare itself
 *    `blocking`, and `'dialog'` — live while a modal `<Sheet>` is open — is
 *    nothing but that. Both halves were reproduced by the review: `3` graded
 *    the card behind the shortcuts sheet, and `/` navigated out from under the
 *    sheet and left it open with its Escape handler on an element focus had
 *    just left.
 * 4. **Fire twice because a component remounted.** Scopes are a stack: the
 *    most recently mounted instance of a scope is the one that hears the key,
 *    and a second `<ReviewSession>` — a remount mid-render, a stale one that
 *    has not finished unmounting — cannot double-grade a card.
 * 5. **Fire on an event something else already handled.** `defaultPrevented`
 *    is checked, so an input's own Enter handling is never also a shortcut.
 */
import { useEffect, useRef } from 'react';

import {
  BINDINGS,
  SCOPES,
  isApplePlatform,
  parseCombo,
  type Binding,
  type Combo,
  type ScopeId,
  type ShortcutScope,
} from './registry';

export type ShortcutHandler = (event: KeyboardEvent) => void;

/** Binding id → what to do, or `undefined` for "not applicable right now". */
export type ShortcutHandlers = Readonly<Record<string, ShortcutHandler | undefined>>;

/**
 * Input types that are not text entry.
 *
 * The list is the complement rather than an allowlist of text-ish types
 * because a new input type should default to "treat it as text": being too
 * careful costs a shortcut that does not fire on a colour picker, being too
 * loose costs navigation while somebody types.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Elements a keyboard user presses with Enter or Space. */
const ACTIVATES_ON_ENTER_OR_SPACE = new Set(['BUTTON', 'SUMMARY', 'SELECT']);

/** Whether a key aimed at this element is a character somebody is typing. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const element = target as Partial<HTMLElement> & { type?: string };
  if (typeof element.tagName !== 'string') return false;
  if (element.isContentEditable === true) return true;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;
  // `type="search"` — what the lookup box is — is text entry, and is exactly
  // the case W8's rule 1 is about.
  return !NON_TEXT_INPUT_TYPES.has((element.type ?? 'text').toLowerCase());
}

/**
 * Whether the focused element already means something by this key.
 *
 * Two kinds do. A **text entry** owns every unmodified key, because every one
 * of them is a character somebody may be typing — W8 rule 1. A **link, button,
 * `<summary>` or `<select>`** owns Enter and Space specifically, because those
 * are how a keyboard user presses it; taking them is how a shortcut silently
 * disables the tab bar.
 */
export function focusOwnsKey(target: EventTarget | null, combo: Combo): boolean {
  if (isTextEntry(target)) return true;
  if (combo.key !== 'Enter' && combo.key !== ' ') return false;
  const element = target as Partial<HTMLElement> & { href?: string };
  if (typeof element?.tagName !== 'string') return false;
  if (ACTIVATES_ON_ENTER_OR_SPACE.has(element.tagName)) return true;
  if (element.tagName === 'A' && typeof element.href === 'string' && element.href !== '') return true;
  return element.getAttribute?.('role') === 'button';
}

/**
 * Does this event *press* this combination?
 *
 * `mod` is ⌘ on Apple and Ctrl elsewhere, and matching asks which — see
 * `isApplePlatform` in `registry.ts` for why the permissive "either modifier
 * anywhere" rule was wrong. `shift` is only consulted for named keys, for the
 * reason recorded on `Combo.shift`.
 */
export function matchesCombo(
  combo: Combo,
  event: KeyboardEvent,
  apple = isApplePlatform(),
): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key !== combo.key) return false;
  const mod = apple ? event.metaKey : event.metaKey || event.ctrlKey;
  if (mod !== combo.mod) return false;
  if (event.altKey !== combo.alt) return false;
  if (combo.key.length > 1 && event.shiftKey !== combo.shift) return false;
  return true;
}

/**
 * W8 rule 1, generalised — see `focusOwnsKey`.
 *
 * A binding carrying `Mod` is not a character anybody can type, so it fires
 * wherever focus is: that is what makes `Mod+K` reach the lookup box *from* the
 * lookup box. **`Alt` is not in that sentence**, and the first version of this
 * file had it there: on macOS Option+letter *is* a character (Option+K is ˚),
 * and on an AltGr layout so is AltGr+letter. Raised by the adversarial review;
 * no binding uses Alt today, so this is closing a door rather than a bug.
 */
export function overridesFocusedElement(combo: Combo, scope: ShortcutScope): boolean {
  if (combo.mod) return true;
  return scope.overridesFocusedElement;
}

export interface LiveScope {
  scope: ScopeId;
  /** Read at dispatch time, so a re-render never has to re-subscribe. */
  handlers: () => ShortcutHandlers;
}

export interface Resolution {
  binding: Binding;
  /** Absent when the surface that owns the binding has nothing to do right now. */
  handler?: ShortcutHandler;
}

const combosOf = (() => {
  const cache = new Map<string, Combo[]>();
  return (binding: Binding): Combo[] => {
    let parsed = cache.get(binding.id);
    if (!parsed) {
      parsed = binding.keys.map(parseCombo);
      cache.set(binding.id, parsed);
    }
    return parsed;
  };
})();

/**
 * Which binding this event presses, and what to run.
 *
 * **The first match in priority order wins and the search stops there**, even
 * if that binding turns out to be blocked by the focus rule or to have no
 * handler mounted. That is deliberate: a more specific live surface *shadows*
 * the one under it, so a palette that binds Enter takes Enter away from
 * whatever is behind it rather than firing both. The shipped table has no
 * cross-scope duplicate and `tests/unit/keys/registry.test.ts` says so; this
 * rule is what makes the day one arrives a decision rather than a race.
 *
 * A **blocking** scope stops the search whether or not it claims the key. That
 * is the whole of `'dialog'`: while a modal sheet is open, nothing underneath
 * it hears a keystroke.
 */
export function resolveBinding(
  event: KeyboardEvent,
  live: readonly LiveScope[],
  bindings: readonly Binding[] = BINDINGS,
  scopes: Record<string, ShortcutScope> = SCOPES,
): Resolution | undefined {
  if (event.defaultPrevented) return undefined;
  // The IME guard. See the header.
  if (event.isComposing || event.keyCode === 229) return undefined;

  const ordered = [...live].sort(
    (a, b) => (scopes[b.scope]?.priority ?? 0) - (scopes[a.scope]?.priority ?? 0),
  );

  for (const entry of ordered) {
    const scope = scopes[entry.scope];
    if (!scope) continue;
    for (const binding of bindings) {
      if (binding.scope !== entry.scope) continue;
      const combo = combosOf(binding).find((candidate) => matchesCombo(candidate, event));
      if (!combo) continue;
      if (focusOwnsKey(event.target, combo) && !overridesFocusedElement(combo, scope)) {
        return undefined;
      }
      const handler = entry.handlers()[binding.id];
      return handler === undefined ? { binding } : { binding, handler };
    }
    if (scope.blocking) return undefined;
  }
  return undefined;
}

/**
 * The live scopes, newest instance of each last.
 *
 * Module state rather than a React context on purpose: the dispatcher has to
 * see every live surface at once to answer "which of these wants this key",
 * and a context gives each consumer only its own subtree.
 */
const stacks = new Map<ScopeId, LiveScope[]>();
let attached = false;

function onKeyDown(event: KeyboardEvent): void {
  const live: LiveScope[] = [];
  for (const stack of stacks.values()) {
    const top = stack[stack.length - 1];
    if (top) live.push(top);
  }
  const resolved = resolveBinding(event, live);
  if (!resolved?.handler) return;
  // Every firing binding takes the key. Without this, `/` types a slash into
  // the box it just focused and Space scrolls the practice page it just graded.
  event.preventDefault();
  resolved.handler(event);
}

function subscribe(entry: LiveScope): () => void {
  const stack = stacks.get(entry.scope) ?? [];
  stack.push(entry);
  stacks.set(entry.scope, stack);
  if (!attached && typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
    attached = true;
  }
  return () => {
    const current = stacks.get(entry.scope);
    if (current) {
      const at = current.indexOf(entry);
      if (at >= 0) current.splice(at, 1);
      if (current.length === 0) stacks.delete(entry.scope);
    }
    if (attached && stacks.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
      attached = false;
    }
  };
}

/**
 * Make a scope live for as long as the calling component is mounted.
 *
 * `handlers` is read through a ref, so passing a fresh object literal every
 * render — which every caller does — costs nothing and never re-subscribes. A
 * handler that is `undefined` means the surface has nothing to do with that
 * binding *right now* (no card on screen, the answer not yet revealed), and the
 * key falls through to the browser untouched, which is what it did before this
 * file existed.
 */
export function useShortcuts(
  scope: ScopeId,
  handlers: ShortcutHandlers,
  options: { enabled?: boolean } = {},
): void {
  const { enabled = true } = options;
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    if (!enabled) return;
    return subscribe({ scope, handlers: () => latest.current });
  }, [scope, enabled]);
}

/** Test seam: forget every live scope. Not used by the app. */
export function resetShortcutsForTests(): void {
  stacks.clear();
  if (attached && typeof window !== 'undefined') {
    window.removeEventListener('keydown', onKeyDown);
    attached = false;
  }
}
