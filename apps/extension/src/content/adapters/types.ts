import type { Cue } from '../../core/types';

/** Playback control. Most sites take the `<video>` element as-is; Netflix overrides `seek`. */
export interface Player {
  readonly video: HTMLVideoElement;
  currentMs(): number;
  seek(ms: number): void;
  play(): void;
  pause(): void;
  isPaused(): boolean;
  setRate(rate: number): void;
  rate(): number;
}

export interface EpisodeTracks {
  /** Stable id for the episode on this site, e.g. YouTube's video id. */
  episodeId: string;
  title: string;
  zh: Cue[];
  en: Cue[];
  /** Human labels for what was found, shown in the sidebar footer. */
  zhLabel: string;
  enLabel: string;
}

/**
 * One streaming site. Everything else — grouping, dictionary, overlay,
 * sidebar, keys — is shared, so a new site is this interface and nothing more.
 */
export interface SiteAdapter {
  readonly site: string;
  /** The element the subtitle card mounts inside; it must be the one that goes fullscreen. */
  container(): HTMLElement | null;
  player(): Player | null;
  /** Current episode id, or null when the page isn't playing one. */
  episodeId(): string | null;
  /** Fetch both tracks for the current episode. Rejects with a message the sidebar can show. */
  loadTracks(): Promise<EpisodeTracks>;
  /** Call `onChange` whenever the site navigates to another episode without a page load. */
  watchNavigation(onChange: () => void): void;
  /** Hide the site's own subtitles while Kànjù shows its card. */
  hideNativeSubtitles(hidden: boolean): void;
}
