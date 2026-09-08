/**
 * "Every explicit Add joins the Looked up list" (PLAN.md §3.3 provenance, §4 P3).
 *
 * `repository.addCardFromEntry` deliberately knows nothing about lists — it is
 * the frozen seam — so the join lives here, one call further out. P1 (lookup),
 * P4 (ask) and P5 (reader) should add through `addCardTracked` rather than
 * calling the repository directly; see HANDOFF.md, "Phases 1–3 (merged)".
 */

import type { CardRow, PhraseToken } from '@/lib/db/schema';
import { isPhraseSnapshot } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import { ensureSystemLists, findLookedUpList } from '@/lib/lists/system-lists';
import type { CardContext, ContextSource, Entry, EntryId } from '@/lib/types';

/** The three sources that mean "the learner chose this word", per §3.3. */
export const EXPLICIT_SOURCES: readonly ContextSource[] = ['lookup', 'ask', 'reader'];

export function isExplicitSource(source: ContextSource | undefined): boolean {
  return source !== undefined && EXPLICIT_SOURCES.includes(source);
}

/** Put entries in the "Looked up" list, creating the list if this is the first. */
export async function joinLookedUp(repo: Repository, entryIds: EntryId[]): Promise<void> {
  if (entryIds.length === 0) return;
  const lists = await ensureSystemLists(repo);
  const list = findLookedUpList(lists);
  if (!list) return;
  await repo.addListMembers(list.id, entryIds);
}

/**
 * Add a card the way the UI should: the repository call, plus the provenance
 * bookkeeping around it. Idempotent, because both halves are.
 */
export async function addCardTracked(
  repo: Repository,
  entry: Entry,
  context?: CardContext,
  senseIndex?: number,
  dictVersion?: string,
): Promise<CardRow> {
  const card = await repo.addCardFromEntry(entry, context, senseIndex, dictVersion);
  if (isExplicitSource(context?.source)) {
    await joinLookedUp(repo, [entry.id]);
    // "Known" and "due today" cannot both be true. An explicit Add is the
    // learner asking to study this word, so it wins over an earlier "Mark
    // known" — otherwise the reader paints the word known while the queue
    // serves it and the Looked-up list reads "known · Queued".
    await repo.unmarkKnown([entry.id]);
  }
  return card;
}

export interface TrackedAdd {
  card: CardRow;
  /** False when the card already existed — the UI must not claim an Add. */
  created: boolean;
  /**
   * True when the stored card carries the context this call passed: either it
   * was written fresh, or the repository merged the missing fields onto an
   * existing card (`mergeCardContext`).
   */
  contextApplied: boolean;
}

/**
 * `addCardTracked`, plus the two facts a UI needs to tell the truth about what
 * just happened. A word the spine drew this morning is already a card, and
 * "Added to your cards" over a row that was there before is the kind of lie
 * that teaches a learner to distrust the button.
 */
export async function addCardChecked(
  repo: Repository,
  entry: Entry,
  context?: CardContext,
  senseIndex?: number,
  dictVersion?: string,
): Promise<TrackedAdd> {
  const before = await repo.cardForEntry(entry.id, senseIndex);
  const card = await addCardTracked(repo, entry, context, senseIndex, dictVersion);
  return {
    card,
    created: before === undefined,
    contextApplied: contextMatches(card.context, context),
  };
}

/** Every field the caller asked for is on the stored card. */
function contextMatches(stored: CardContext | undefined, wanted: CardContext | undefined): boolean {
  if (!wanted) return true;
  if (!stored) return false;
  const fields = ['sentence', 'question', 'query', 'offset', 'length'] as const;
  return fields.every((field) => wanted[field] === undefined || stored[field] === wanted[field]);
}

// ---------------------------------------------------------------------------
// Phrases
// ---------------------------------------------------------------------------

/** The identity of a phrase card: the characters on its front. */
export function phraseKey(tokens: readonly PhraseToken[]): string {
  return tokens.map((token) => token.text).join('');
}

/**
 * The phrase card for these tokens, if the learner already has one.
 *
 * `addPhraseCard` is the one Add in the app that is not idempotent — the frozen
 * repository interface has no `phraseCardFor` to ask first, and the panel's
 * disabled state is per-mount, so asking the same question after a reload and
 * pressing Add again wrote a second identical card and the review session
 * offered both. The check lives here rather than in the repository for the same
 * reason the "Looked up" join does: the seam below is frozen.
 */
export async function phraseCardFor(
  repo: Repository,
  tokens: readonly PhraseToken[],
): Promise<CardRow | undefined> {
  const key = phraseKey(tokens);
  if (!key) return undefined;
  const cards = await repo.allCards();
  return cards.find(
    (card) => card.kind === 'phrase' && isPhraseSnapshot(card.snapshot) && card.snapshot.simp === key,
  );
}

export interface PhraseAdd {
  card: CardRow;
  /** False when the card was already there — the UI must not claim an Add. */
  created: boolean;
}

/**
 * `addPhraseCard`, made idempotent the way word adds already are. Two identical
 * phrase cards are not two things to learn.
 */
export async function addPhraseCardChecked(
  repo: Repository,
  tokens: PhraseToken[],
  en: string,
  context: CardContext,
  dictVersion?: string,
): Promise<PhraseAdd> {
  const existing = await phraseCardFor(repo, tokens);
  if (existing) return { card: existing, created: false };
  return { card: await repo.addPhraseCard(tokens, en, context, dictVersion), created: true };
}
