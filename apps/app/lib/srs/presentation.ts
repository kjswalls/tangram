/**
 * What a card shows (PLAN.md §4, P2).
 *
 * Cards render from their snapshot, never from the live dictionary, so a
 * dictionary rebuild can never change what is on a card. Everything here is a
 * pure read of that snapshot plus `settings.script`.
 */

import type { CardRow, CardSnapshot, ScriptPreference } from '@/lib/db/schema';
import { isPhraseSnapshot } from '@/lib/db/schema';
import type { HskBand } from '@/lib/types';
import { hskBandLabel } from '@/lib/types';

export interface CardFace {
  /** The headword in the learner's chosen script. */
  primary: string;
  /** The other script, when the two forms differ. */
  secondary?: string;
  /** `Traditional` or `Simplified` — what `secondary` is. */
  secondaryLabel?: string;
  /**
   * The snapshot's numbered reading, so `<HanziText>` can align it character by
   * character (core.md C3). It is the SNAPSHOT's, not the dictionary's: a card
   * renders from the snapshot so that a dictionary rebuild cannot silently
   * change what is on it, and the reading is part of that.
   *
   * The same reading serves both `primary` and `secondary` — CC-CEDICT's
   * traditional and simplified columns are the same word with the same reading,
   * which is why one `pinyinNum` sits on the face rather than one per script.
   */
  pinyinNum?: string;
}

/**
 * The front of a card: simplified by default, traditional alongside it when it
 * differs (`settings.script` flips which one leads).
 */
export function cardFace(snapshot: CardSnapshot, script: ScriptPreference): CardFace {
  // A phrase's `pinyinNum` is the model's, token by token, and a phrase face
  // renders its own tokens through `PhraseFace` — so no word-level reading here.
  if (isPhraseSnapshot(snapshot)) return { primary: snapshot.simp };

  const wantsTrad = script === 'trad';
  const primary = wantsTrad ? snapshot.trad : snapshot.simp;
  const other = wantsTrad ? snapshot.simp : snapshot.trad;
  const reading = snapshot.pinyinNum ? { pinyinNum: snapshot.pinyinNum } : {};
  if (!other || other === primary) return { primary, ...reading };
  return {
    primary,
    secondary: other,
    secondaryLabel: wantsTrad ? 'Simplified' : 'Traditional',
    ...reading,
  };
}

export interface GlossGroups {
  /** Shown first: the chosen sense when the card has one, else every gloss. */
  chosen: string[];
  /** Collapsed under "other senses". */
  others: string[];
}

/**
 * A card added from a specific sense (an ask match, a chosen reading) is about
 * that sense: it leads, and the rest of the entry stays available but folded
 * away (§3.4). Without a `senseIndex` the entry reads as it does in the
 * dictionary.
 */
export function orderGlosses(glosses: readonly string[], senseIndex?: number): GlossGroups {
  if (
    senseIndex === undefined ||
    !Number.isInteger(senseIndex) ||
    senseIndex < 0 ||
    senseIndex >= glosses.length
  ) {
    return { chosen: [...glosses], others: [] };
  }
  return {
    chosen: [glosses[senseIndex]],
    others: glosses.filter((_, index) => index !== senseIndex),
  };
}

export interface CardBack {
  pinyinMarked: string;
  glosses: GlossGroups;
  classifiers: string[];
  hskBand?: HskBand;
  hskLabel?: string;
  /** Phrase cards answer an English prompt rather than carrying glosses. */
  en?: string;
}

export function cardBack(card: Pick<CardRow, 'snapshot' | 'senseIndex'>): CardBack {
  const snapshot = card.snapshot;
  if (isPhraseSnapshot(snapshot)) {
    return {
      pinyinMarked: snapshot.pinyinMarked,
      glosses: { chosen: [], others: [] },
      classifiers: [],
      en: snapshot.en,
    };
  }
  return {
    pinyinMarked: snapshot.pinyinMarked,
    glosses: orderGlosses(snapshot.glosses, card.senseIndex),
    classifiers: snapshot.classifiers,
    ...(snapshot.hskBand === undefined
      ? {}
      : { hskBand: snapshot.hskBand, hskLabel: `HSK ${hskBandLabel(snapshot.hskBand)}` }),
  };
}

/** The headword to look for when a context has no offset (`lib/srs/context.ts`). */
export function cardTargetText(snapshot: CardSnapshot, script: ScriptPreference): string {
  return cardFace(snapshot, script).primary;
}
