import type { CardRow, PhraseToken } from '@/lib/db/schema';
import { isPhraseSnapshot } from '@/lib/db/schema';

export interface PhraseFaceProps {
  card: CardRow;
}

/**
 * The front of a phrase card.
 *
 * A phrase card's snapshot is a list of tokens, each one either a cited
 * dictionary entry or a string the model invented (`lib/db/schema.ts`,
 * `PhraseToken`) — and the review path used to draw none of that distinction:
 * it rendered `snapshot.simp`, the joined text, at 6xl with no flag anywhere on
 * the card (HANDOFF.md, Phases 4–5 review fixes, "Not done, and why"). Adding a
 * phrase with an unverified token is refused at the Add now, but a card written
 * before that rule exists in databases already — and the card is the thing the
 * learner memorises. This is the last path by which an ungrounded character
 * could reach them unflagged.
 *
 * Two rules hold it up:
 *
 *  - **A token with no `entryId` is ungrounded, whatever the row says.** The
 *    stored `unverified` flag is honoured when it is there, but it is not
 *    required: a snapshot written before that flag existed carries neither, and
 *    "no dictionary row stands behind this" is derivable from the citation
 *    alone. The two are marked apart because they are different failures —
 *    characters the model invented, versus a cited run that the segmenter could
 *    not confirm is a word.
 *  - **No pinyin here.** The ask panel prints a reading under every token
 *    because it is answering a question; this is the *front* of a review card,
 *    where the reading is the answer. The flag still has to be visible before
 *    the flip — a learner who rehearses an invented character has already lost
 *    — so it travels as a marked glyph and a warning line, never as a reading.
 */
export function PhraseFace({ card }: PhraseFaceProps) {
  const snapshot = isPhraseSnapshot(card.snapshot) ? card.snapshot : null;
  if (!snapshot) return null;

  const tokens = (snapshot.tokens ?? []).filter((token) => token.text.length > 0);

  // A snapshot with no usable token array still has to render something, and
  // the joined text is what the card has always shown. Blanking the face
  // because the provenance is thin would lose the card without verifying it.
  if (tokens.length === 0) {
    return (
      <h2
        data-testid="phrase-face"
        data-tokens="false"
        className="hanzi text-6xl font-medium sm:text-7xl"
      >
        {snapshot.simp}
      </h2>
    );
  }

  const flagged = tokens.filter((token) => ungrounded(token) || token.unverified === true);

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <h2
        data-testid="phrase-face"
        data-tokens="true"
        data-unverified={flagged.length > 0 ? 'true' : 'false'}
        // The phrase is drawn one token at a time, so the accessible name comes
        // from the snapshot rather than from the spans a screen reader would
        // otherwise announce as separate words.
        aria-label={snapshot.simp}
        className="hanzi flex flex-wrap items-baseline justify-center gap-x-2 text-6xl font-medium sm:text-7xl"
      >
        {tokens.map((token, index) => {
          const ai = ungrounded(token);
          const unverified = !ai && token.unverified === true;
          return (
            <span
              key={`${token.entryId ?? token.text}-${index}`}
              data-testid="phrase-face-token"
              data-entry-id={token.entryId ?? ''}
              data-ai-generated={ai ? 'true' : 'false'}
              data-unverified={ai || unverified ? 'true' : 'false'}
              title={
                ai
                  ? 'AI-generated: no dictionary entry stands behind this token.'
                  : unverified
                    ? 'Unverified: these characters are not a word this dictionary lists.'
                    : undefined
              }
              className={
                ai || unverified
                  ? 'text-warning decoration-warning underline decoration-dotted underline-offset-8'
                  : undefined
              }
            >
              {token.text}
            </span>
          );
        })}
      </h2>

      {flagged.length > 0 ? (
        <p data-testid="phrase-face-warning" className="max-w-prose text-sm text-warning">
          {flagged.length === 1 ? 'The marked token is' : 'The marked tokens are'} not verified
          against the dictionary — treat {flagged.length === 1 ? 'it' : 'them'} as a suggestion, not
          a reading.
        </p>
      ) : null}
    </div>
  );
}

/**
 * No citation, no ground: a token that names no entry is the model's own string
 * however the row was written. `unverified` is the *additional* claim — a cited
 * token the segmenter could not confirm — and is read separately.
 */
function ungrounded(token: PhraseToken): boolean {
  return !token.entryId;
}
