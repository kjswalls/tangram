/**
 * Provenance on a card (PLAN.md §1, commitment 2).
 *
 * The sentence the word was met in — or the question that produced it — travels
 * with the card and is shown on its back with the target highlighted. On the
 * *front* the same sentence can be peeked at with the target masked, which is
 * the only way to show context without giving the answer away.
 */

import type { CardContext } from '@/lib/types';

/** The mask stands in for the target, one box per character. */
export const MASK_CHAR = '＿';

/** The provenance line itself: the sentence, else the question, else the query. */
export function contextText(context: CardContext | undefined): string | null {
  if (!context) return null;
  const text = context.sentence ?? context.question ?? context.query ?? null;
  return text && text.trim().length > 0 ? text : null;
}

/** What kind of provenance the line is, for the label above it. */
export function contextLabel(context: CardContext): string {
  if (context.sentence) return 'From the sentence';
  if (context.question) return 'From the question';
  return 'From the lookup';
}

export interface ContextParts {
  before: string;
  target: string;
  after: string;
}

/**
 * Split the provenance line around the target.
 *
 * `offset`/`length` are used when present and in range (the reader writes them,
 * §3.5). When they are absent — a lookup that only kept the query — the
 * headword is located in the text instead, and when that fails too there is no
 * split: the line renders whole rather than highlighting the wrong characters.
 */
export function splitContext(
  text: string,
  offset?: number,
  length?: number,
  fallbackTarget?: string,
): ContextParts | null {
  if (
    offset !== undefined &&
    length !== undefined &&
    Number.isInteger(offset) &&
    Number.isInteger(length) &&
    offset >= 0 &&
    length > 0 &&
    offset + length <= text.length
  ) {
    return {
      before: text.slice(0, offset),
      target: text.slice(offset, offset + length),
      after: text.slice(offset + length),
    };
  }

  if (fallbackTarget && fallbackTarget.length > 0) {
    const at = text.indexOf(fallbackTarget);
    if (at >= 0) {
      return {
        before: text.slice(0, at),
        target: text.slice(at, at + fallbackTarget.length),
        after: text.slice(at + fallbackTarget.length),
      };
    }
  }

  return null;
}

/** The mask that replaces the target on the front, one box per code point. */
export function maskFor(target: string): string {
  return MASK_CHAR.repeat([...target].length);
}

/**
 * The peeked line: the same sentence with the target blanked out. Returns null
 * when the target cannot be located, because a "peek" that quietly shows the
 * answer is worse than no peek at all.
 */
export function maskedContext(parts: ContextParts | null): string | null {
  if (!parts) return null;
  return `${parts.before}${maskFor(parts.target)}${parts.after}`;
}

export interface ResolvedContext {
  /** The provenance line: sentence, question or query. */
  text: string;
  /** Split around the target, or null when the target could not be located. */
  parts: ContextParts | null;
  label: string;
}

/**
 * Everything the two context renderings need, resolved once. `targets` are the
 * headword forms to fall back on, most likely first (the script the learner
 * reads in, then the other one — a sentence mined in simplified still has to
 * highlight for a learner set to traditional).
 */
export function resolveContext(
  context: CardContext | undefined,
  targets: readonly string[] = [],
): ResolvedContext | null {
  if (!context) return null;
  const text = contextText(context);
  if (text === null) return null;

  // Provenance that is only the headword is not provenance. A card whose
  // context reads 大概 offered "Peek context" and revealed ＿＿, then showed a
  // back line that highlighted the whole of itself. Nothing to show is better
  // than a box that says the word again.
  if (targets.some((target) => target.length > 0 && target === text.trim())) return null;

  let parts = splitContext(text, context.offset, context.length, targets[0]);
  for (const target of targets.slice(1)) {
    if (parts) break;
    parts = splitContext(text, undefined, undefined, target);
  }
  return { text, parts, label: contextLabel(context) };
}
