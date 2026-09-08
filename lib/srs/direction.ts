/**
 * The production direction — meaning → hanzi (PLAN.md §3.3; Phase 8, builder B).
 *
 * Recognition asks "what does 打算 mean?". Production asks the harder and more
 * useful question: "you mean *to plan* — write it". They are **two memories**,
 * so they are two `cards` rows with two FSRS states (`CardDirection`,
 * `lib/db/schema.ts`), never one row asked two ways. Nothing here schedules
 * anything: the scheduler cannot tell the directions apart, and that is the
 * point — grading one twin cannot move the other, because they are different
 * rows and no code path writes both.
 *
 * Everything decidable without a database is decided here so the components
 * stay thin and the rules stay testable:
 *
 *  - **Creation is deliberate.** `settings.productionDirection` only reveals
 *    the two controls that make twins (the card back's "add the reverse" and a
 *    list's "also study production"). Turning the setting on creates nothing —
 *    a switch that silently doubled an established queue overnight would be the
 *    app deciding a learner's week for them.
 *  - **The bulk path is capped.** `planProductionTwins` takes a limit and
 *    `addProductionTwins` fills it from the day's remaining new-card allowance
 *    (`buildQueue(...).drawLimit`) and charges the counter, exactly as a list's
 *    "Add to queue" does. What it will not fit today it reports as `pending`.
 *  - **An exact answer needs no model.** `gradeProduction` decides
 *    exact / other-script / near / wrong locally; only a genuine near-miss is
 *    handed to the recall provider, and even then the result is a *suggestion*
 *    (Phase 7's rule: nothing here can submit a grade).
 *  - **Either script is right.** A learner set to simplified who writes the
 *    traditional form has produced the word. It is accepted and said out loud,
 *    not marked wrong.
 *
 * Client-safe: types only from the db layer, no Dexie, no `server-only`.
 */

import {
  requestRecallGrade,
  type RecallGradeValue,
  type RecallRequest,
  type RecallSuggestion,
} from '@/lib/ai/recall';
import type { Repository } from '@/lib/db/repository';
import type {
  CardDirection,
  CardRow,
  CardSnapshot,
  EntrySnapshot,
  ScriptPreference,
} from '@/lib/db/schema';
import { isPhraseSnapshot } from '@/lib/db/schema';
import { buildQueue } from '@/lib/lists/queue';
import { maskFor } from '@/lib/srs/context';
import { todayKey } from '@/lib/srs/day';
import type { CardContext, Entry, EntryId } from '@/lib/types';

export const PRODUCTION: CardDirection = 'production';
export const RECOGNITION: CardDirection = 'recognition';

/** A card row written before Phase 8 has no direction at all; it is recognition. */
export function directionOf(card: Pick<CardRow, 'direction'>): CardDirection {
  return card.direction === PRODUCTION ? PRODUCTION : RECOGNITION;
}

export function isProduction(card: Pick<CardRow, 'direction'>): boolean {
  return directionOf(card) === PRODUCTION;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * What makes two cards the same question asked both ways round: the entry and
 * the sense, never the direction. Phrase cards have no entry, so they key on
 * their own id and can never collide with anything.
 */
export function twinKey(card: Pick<CardRow, 'id' | 'entryId' | 'senseIndex'>): string {
  if (!card.entryId) return `card:${card.id}`;
  return `${card.entryId}::${card.senseIndex ?? ''}`;
}

/** The word a card is about, for "do not show both directions back to back". */
export function entryKey(card: Pick<CardRow, 'id' | 'entryId'>): string {
  return card.entryId ?? `card:${card.id}`;
}

const alive = (card: CardRow): boolean => card.deletedAt === null;

/**
 * Which card should represent an entry in a per-word view (a list row, a
 * reader token). Recognition wins: it is the card every pre-Phase-8 view was
 * written against, and a brand-new production twin must not repaint a word the
 * learner has known for months as "new". Between two of the same direction the
 * better-remembered one wins.
 */
export function preferRecognition(existing: CardRow | undefined, next: CardRow): CardRow {
  if (!existing) return next;
  const existingRecognition = !isProduction(existing);
  const nextRecognition = !isProduction(next);
  if (existingRecognition !== nextRecognition) return existingRecognition ? existing : next;
  return next.fsrs.stability > existing.fsrs.stability ? next : existing;
}

/** The live production card for a twin key, if the learner has made one. */
export function twinsByKey(cards: readonly CardRow[]): Map<string, CardRow> {
  const twins = new Map<string, CardRow>();
  for (const card of cards) {
    if (!alive(card) || !isProduction(card)) continue;
    twins.set(twinKey(card), card);
  }
  return twins;
}

export function hasProductionTwin(cards: readonly CardRow[], card: CardRow): boolean {
  return twinsByKey(cards).has(twinKey(card));
}

// ---------------------------------------------------------------------------
// Counting and ordering
// ---------------------------------------------------------------------------

export interface DirectionCounts {
  recognition: number;
  production: number;
  total: number;
}

/** The Today split: what the learner signed up for, in the two directions. */
export function countByDirection(cards: readonly CardRow[]): DirectionCounts {
  let production = 0;
  for (const card of cards) if (isProduction(card)) production += 1;
  return { recognition: cards.length - production, production, total: cards.length };
}

/**
 * Keep a word's two directions off each other's heels.
 *
 * Recognition then production of the same word back to back is not a review of
 * two memories: the answer to the second is sitting on the back of the first.
 * The queue's order is otherwise preserved — this only ever pulls the next card
 * about a *different* word forward, and when there is no such card (a queue of
 * one word) the order stands rather than dropping anything.
 */
export function spaceDirections(cards: readonly CardRow[]): CardRow[] {
  const rest = [...cards];
  const out: CardRow[] = [];
  let last: string | null = null;
  while (rest.length > 0) {
    let index = 0;
    if (last !== null) {
      const other = rest.findIndex((card) => entryKey(card) !== last);
      if (other > 0) index = other;
    }
    const [next] = rest.splice(index, 1);
    if (!next) break;
    out.push(next);
    last = entryKey(next);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Making a twin
// ---------------------------------------------------------------------------

/**
 * A dictionary entry rebuilt from the snapshot a card already carries.
 *
 * `addCardFromEntry` takes an `Entry`, and the twin of an existing card must be
 * cut from the same cloth as its recognition original — the same headword, the
 * same glosses, the same `dictVersion` — rather than from today's dictionary,
 * which may have been rebuilt since. It is also what lets "add the reverse"
 * work with no network and no `data/` build at all.
 *
 * `properNoun`/`isVariant`/`surname` are false because they are draw-time
 * filters that never reach a snapshot; nothing about the card that gets written
 * reads them.
 */
export function entryFromSnapshot(entryId: EntryId, snapshot: EntrySnapshot): Entry {
  return {
    id: entryId,
    simp: snapshot.simp,
    trad: snapshot.trad,
    pinyinNum: snapshot.pinyinNum,
    pinyinMarked: snapshot.pinyinMarked,
    glosses: [...snapshot.glosses],
    classifiers: [...snapshot.classifiers],
    properNoun: false,
    isVariant: false,
    surname: false,
    ...(snapshot.hskBand === undefined ? {} : { hskBand: snapshot.hskBand }),
    ...(snapshot.freqRank === undefined ? {} : { freqRank: snapshot.freqRank }),
  };
}

/** The word snapshot of a card, or null for a phrase (which has no headword). */
export function wordSnapshot(snapshot: CardSnapshot): EntrySnapshot | null {
  return isPhraseSnapshot(snapshot) ? null : snapshot;
}

/**
 * The provenance a twin inherits.
 *
 * The sentence travels: a production card whose front is the blanked sentence
 * the word was met in is the whole reason provenance is stored (PLAN.md §1,
 * commitment 2). What can change is the *source*, and it decides who pays for
 * the card: the bulk list path passes `'list'`, so its twins are counted
 * against the day exactly as a list's "Add to queue" is, while a single "add
 * the reverse" keeps the original source and is an explicit add like any other.
 */
export function twinContext(
  card: Pick<CardRow, 'context'>,
  now: number,
  source?: CardContext['source'],
): CardContext | undefined {
  const original = card.context;
  if (!original) return source === undefined ? undefined : { source, addedAt: now };
  return { ...original, source: source ?? original.source, addedAt: now };
}

export interface TwinPlanInput {
  cards: readonly CardRow[];
  /** Restrict to these entries, in this order — a list's own order. */
  entryIds?: readonly EntryId[];
  /** How many may be created. Anything beyond it is `pending`. */
  limit: number;
  /**
   * Only twin words the learner has actually started (default true). Producing
   * a word you have never once recognised is not the next step, and a list of
   * thirty untouched words would otherwise become sixty in one press.
   */
  requireStarted?: boolean;
}

export interface TwinPlan {
  /** Recognition cards to twin now, in order. */
  create: CardRow[];
  /** Eligible cards the limit did not reach. */
  pending: number;
}

/**
 * Which recognition cards want a production twin, bounded by the caller's
 * limit. Pure: it decides, `addProductionTwins` writes.
 */
export function planProductionTwins(input: TwinPlanInput): TwinPlan {
  const twins = twinsByKey(input.cards);
  const wanted = input.entryIds ? new Set(input.entryIds) : null;
  const order = new Map<EntryId, number>();
  input.entryIds?.forEach((id, index) => {
    if (!order.has(id)) order.set(id, index);
  });

  const eligible = input.cards
    .filter((card) => {
      if (!alive(card) || isProduction(card)) return false;
      if (card.kind !== 'word' || !card.entryId) return false;
      if (wordSnapshot(card.snapshot) === null) return false;
      if (wanted && !wanted.has(card.entryId)) return false;
      if ((input.requireStarted ?? true) && card.fsrs.state === 0) return false;
      return !twins.has(twinKey(card));
    })
    .sort((a, b) => {
      if (wanted) {
        const left = order.get(a.entryId ?? '') ?? Number.MAX_SAFE_INTEGER;
        const right = order.get(b.entryId ?? '') ?? Number.MAX_SAFE_INTEGER;
        if (left !== right) return left - right;
      }
      return a.createdAt - b.createdAt;
    });

  const limit = Math.max(0, input.limit);
  return { create: eligible.slice(0, limit), pending: Math.max(0, eligible.length - limit) };
}

export interface AddTwinsInput {
  repo: Repository;
  now?: number;
  /** Restrict to a list's entries, in list order. */
  entryIds?: readonly EntryId[];
  /**
   * How many to create. Omitted, it is the day's remaining new-card allowance
   * (`buildQueue(...).drawLimit`) — the same number a spine draw would get.
   */
  limit?: number;
  /** Spend the day's counter for what is created (the bulk path does). */
  charge?: boolean;
  /** Provenance source for the twins; see `twinContext`. */
  source?: CardContext['source'];
  requireStarted?: boolean;
}

export interface AddTwinsResult {
  created: CardRow[];
  /** Eligible cards today's allowance could not reach. */
  pending: number;
  /** The allowance this call worked to. */
  limit: number;
}

/**
 * Create production twins for recognition cards, under the daily cap.
 *
 * The cap is not advisory: with no explicit `limit` this asks `buildQueue` for
 * the same `drawLimit` the spine draw gets, so twins compete with new words for
 * one allowance rather than opening a second one. `charge` then spends it, the
 * way `queueFromList` spends it for a word queued by hand.
 *
 * The write goes through `addCardFromEntry(..., 'production')`, which is
 * idempotent per (entryId, senseIndex, direction) — so a double click, or two
 * tabs, cannot make two twins.
 */
export async function addProductionTwins(input: AddTwinsInput): Promise<AddTwinsResult> {
  const repo = input.repo;
  const now = input.now ?? Date.now();
  const [settings, cards] = await Promise.all([repo.getSettings(), repo.allCards()]);
  const limit = input.limit ?? buildQueue({ now, cards, settings }).drawLimit;

  const plan = planProductionTwins({
    cards,
    limit,
    ...(input.entryIds === undefined ? {} : { entryIds: input.entryIds }),
    ...(input.requireStarted === undefined ? {} : { requireStarted: input.requireStarted }),
  });

  const before = new Set(cards.map((row) => row.id));
  const created: CardRow[] = [];
  for (const card of plan.create) {
    const snapshot = wordSnapshot(card.snapshot);
    if (!snapshot || !card.entryId) continue;
    const twin = await repo.addCardFromEntry(
      entryFromSnapshot(card.entryId, snapshot),
      twinContext(card, now, input.source),
      card.senseIndex,
      snapshot.dictVersion,
      PRODUCTION,
    );
    // `addCardFromEntry` is idempotent, so a twin another tab wrote a moment
    // ago comes back here too. Only a row that was not in the read this plan
    // was made from is a creation, and only a creation is charged for.
    if (!before.has(twin.id)) created.push(twin);
  }

  if (input.charge && created.length > 0) {
    await repo.bumpIntroduced(todayKey(now, settings.dayRollover), created.length);
  }

  return { created, pending: plan.pending, limit };
}

// ---------------------------------------------------------------------------
// What the front may show
// ---------------------------------------------------------------------------

/**
 * The headword forms a production answer is judged against: the script the
 * learner reads in first, then the other one when it differs.
 */
export interface HeadwordForms {
  preferred: string;
  other: string | null;
  /** Both, normalised, for comparison. */
  all: string[];
}

export function headwordForms(
  snapshot: EntrySnapshot,
  script: ScriptPreference,
): HeadwordForms {
  const preferred = script === 'trad' ? snapshot.trad : snapshot.simp;
  const raw = script === 'trad' ? snapshot.simp : snapshot.trad;
  const other = raw && raw !== preferred ? raw : null;
  const all = [preferred, ...(other ? [other] : [])]
    .map(normalizeProduced)
    .filter((form) => form.length > 0);
  return { preferred, other, all };
}

/** `Traditional` / `Simplified` — what the *other* form is called. */
export function otherScriptLabel(script: ScriptPreference): string {
  return script === 'trad' ? 'simplified' : 'traditional';
}

/**
 * Blank the answer out of a line the front is about to show.
 *
 * A gloss can carry the headword itself — CC-CEDICT writes "variant of 打算
 * [da3 suan4]" and "abbr. for …" — and on a production card the headword *is*
 * the answer. The bracketed reading that follows a masked form goes with it: a
 * production card that prints `dǎsuàn` under the question has asked nothing.
 */
export function maskTargets(text: string, forms: readonly string[]): string {
  let masked = text;
  for (const form of forms) {
    if (!form) continue;
    let at = masked.indexOf(form);
    while (at >= 0) {
      let end = at + form.length;
      // Swallow a CC-CEDICT reading attached to the form: 打算[da3 suan4].
      if (masked[end] === '[') {
        const close = masked.indexOf(']', end);
        if (close > 0) end = close + 1;
      }
      masked = `${masked.slice(0, at)}${maskFor(form)}${masked.slice(end)}`;
      at = masked.indexOf(form, at + 1);
    }
  }
  return masked;
}

/** True when the line still contains an answer, so the front must not show it. */
export function revealsTarget(text: string, forms: readonly string[]): boolean {
  return forms.some((form) => form.length > 0 && text.includes(form));
}

// ---------------------------------------------------------------------------
// Grading a produced answer
// ---------------------------------------------------------------------------

const PUNCTUATION =
  /[\s\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/g;

/**
 * What two answers have to share to count as the same: the characters.
 *
 * Whitespace, ASCII and full-width punctuation go; the rest is NFKC-folded and
 * lower-cased so 卡拉ＯＫ and 卡拉ok are one answer. Nothing else is touched —
 * a character is either the one the word is written with or it is not.
 */
export function normalizeProduced(text: string): string {
  return text.normalize('NFKC').replace(PUNCTUATION, '').toLowerCase();
}

const HAN = /\p{Script=Han}/u;

export function hasHan(text: string): boolean {
  return HAN.test(text);
}

/** Levenshtein over code points, so a surrogate pair is one character. */
export function editDistance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      const substitution = previous[j] + (left[i] === right[j] ? 0 : 1);
      current[j + 1] = Math.min(substitution, previous[j + 1] + 1, current[j] + 1);
    }
    previous = current;
  }
  return previous[right.length];
}

export type ProductionOutcome =
  | 'empty'
  | 'exact'
  | 'other-script'
  | 'contains'
  | 'no-hanzi'
  | 'near'
  | 'wrong';

export interface ProductionJudgement {
  outcome: ProductionOutcome;
  suggested: RecallGradeValue;
  /** One line of plain English. Never the answer — the back is where that is. */
  why: string;
  /**
   * A local rule cannot settle this one, and a judgement would genuinely help:
   * one character off, or the same word written another way. Only here does the
   * recall provider get asked anything.
   */
  askProvider: boolean;
}

/** How far off still counts as a near miss rather than a different word. */
function nearLimit(length: number): number {
  return length <= 4 ? 1 : 2;
}

export interface GradeProductionInput {
  typed: string;
  snapshot: EntrySnapshot;
  script: ScriptPreference;
}

/**
 * Judge a produced answer against the headword, locally.
 *
 * The four outcomes that need no model: nothing written, the word itself, the
 * word in the other script (accepted — a learner set to simplified who writes
 * 打算 in traditional has produced the word), and an answer with no hanzi in it
 * at all (pinyin is not the exercise). What is left is a near miss, which is
 * the only case worth a provider call, and everything else, which is a
 * different word and is graded Again here.
 *
 * A suggestion, always: this returns a number for the grade bar to ring, and
 * nothing in this module can press it.
 */
export function gradeProduction(input: GradeProductionInput): ProductionJudgement {
  const forms = headwordForms(input.snapshot, input.script);
  const typed = normalizeProduced(input.typed);
  const preferred = normalizeProduced(forms.preferred);
  const other = forms.other ? normalizeProduced(forms.other) : null;

  if (!typed) {
    return { outcome: 'empty', suggested: 1, why: 'Nothing written.', askProvider: false };
  }
  if (typed === preferred) {
    return { outcome: 'exact', suggested: 3, why: 'Exactly right.', askProvider: false };
  }
  if (other && typed === other) {
    return {
      outcome: 'other-script',
      suggested: 3,
      why: `Right — that is the ${otherScriptLabel(input.script)} form, and it counts.`,
      askProvider: false,
    };
  }
  if (forms.all.some((form) => typed.includes(form))) {
    return {
      outcome: 'contains',
      suggested: 3,
      why: 'The word is in there, with more around it.',
      askProvider: false,
    };
  }
  if (hasHan(preferred) && !hasHan(typed)) {
    return {
      outcome: 'no-hanzi',
      suggested: 1,
      why: 'The answer is the characters themselves, not the reading.',
      askProvider: false,
    };
  }

  const distance = Math.min(...forms.all.map((form) => editDistance(typed, form)));
  const length = [...preferred].length;
  if (distance > 0 && distance < length && distance <= nearLimit(length)) {
    return {
      outcome: 'near',
      suggested: 2,
      why: distance === 1 ? 'One character off.' : `${distance} characters off.`,
      askProvider: true,
    };
  }
  return {
    outcome: 'wrong',
    suggested: 1,
    why: 'That is a different word.',
    askProvider: false,
  };
}

/** The judgement as the grade bar's suggestion. No provider, so no badge. */
export function localSuggestion(judgement: ProductionJudgement): RecallSuggestion {
  return { suggested: judgement.suggested, why: judgement.why };
}

/**
 * The recall box's network seam, for a production card.
 *
 * `RecallInput` (Phase 7) takes a `request` and knows nothing else about
 * grading — so the production direction reuses the box whole and swaps what
 * happens when it is submitted. An exact answer is settled here, in the
 * browser, with no request at all: a match against the headword is not a
 * judgement call and a model cannot make it any truer. Only a near miss is
 * asked about, and if that answer never comes the local reading stands.
 *
 * It cannot grade the card either. Like everything else on this path it returns
 * a suggestion, and the learner still presses the button.
 */
export function productionRecallRequest(
  card: Pick<CardRow, 'snapshot' | 'entryId' | 'senseIndex'>,
  script: ScriptPreference,
  fallback: RecallRequest = requestRecallGrade,
): RecallRequest {
  return async (requestInput, options) => {
    const snapshot = wordSnapshot(card.snapshot);
    if (!snapshot) return null;
    const judgement = gradeProduction({ typed: requestInput.answer, snapshot, script });
    if (!judgement.askProvider) return localSuggestion(judgement);
    try {
      const judged = await fallback(requestInput, options);
      return judged ?? localSuggestion(judgement);
    } catch {
      return localSuggestion(judgement);
    }
  };
}
