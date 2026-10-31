/**
 * Kànjù's shared vocabulary. Everything a site adapter produces is normalised
 * into `Cue`s, and everything the overlay draws is a `Sentence`.
 */

export type Lang = 'zh' | 'en';

/** One subtitle cue, as the site timed it. Times are milliseconds. */
export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

/** A subtitle track the site offers, before it is fetched. */
export interface TrackInfo {
  lang: Lang;
  /** The site's own language code, e.g. `zh-Hans`, `en`. */
  code: string;
  label: string;
  /** True when the site machine-translated or machine-transcribed it. */
  auto: boolean;
}

/** One dictionary reading of a word, trimmed for the overlay. */
export interface Reading {
  pinyinNum: string;
  pinyin: string;
  glosses: string[];
  hsk?: number;
  properNoun?: boolean;
}

/** One segmented piece of a Chinese line. `kind: 'text'` is punctuation, Latin, digits. */
export interface Word {
  text: string;
  kind: 'word' | 'text';
  /** Display pinyin for this word, tone changes applied (不是 → bú shì). */
  pinyin?: string;
  /** Marked pinyin per syllable, tone changes applied, for per-syllable tone colours. */
  syllables?: string[];
  /** Tone number (1–5, 0 for a non-syllable) per syllable, matching `syllables`. */
  tones?: number[];
  readings: Reading[];
}

/** One Chinese cue after segmentation. */
export interface ZhLine extends Cue {
  words: Word[];
}

/**
 * A sentence card: the Chinese and English cues whose times overlap, joined.
 * This is what fixes English that was reordered across cue boundaries.
 */
export interface Sentence {
  id: number;
  startMs: number;
  endMs: number;
  zh: ZhLine[];
  en: Cue[];
}

/** What the content script asks the background worker to do with an episode. */
export interface AnnotateRequest {
  type: 'annotate';
  zh: Cue[];
}

export interface AnnotateResponse {
  ok: true;
  lines: ZhLine[];
}

export interface ErrorResponse {
  ok: false;
  error: string;
}
