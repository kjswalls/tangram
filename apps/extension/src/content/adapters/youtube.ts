import { parseJson3 } from '../../core/parse/json3';
import type { Cue } from '../../core/types';
import { askPage } from '../../page/bridge';
import { Html5Player } from '../html5-player';
import type { EpisodeTracks, Player, SiteAdapter } from './types';

interface PageTrack {
  baseUrl: string;
  languageCode: string;
  /** `asr` for auto-generated. */
  kind: string;
  name: string;
}

interface PageTracks {
  videoId: string | null;
  title: string;
  tracks: PageTrack[];
}

/** Simplified first; traditional still segments, character by character where the dictionary has no match. */
const ZH_PREFERENCE = ['zh-Hans', 'zh-CN', 'zh', 'zh-SG', 'zh-Hant', 'zh-TW', 'zh-HK'];

export function pickChinese(tracks: readonly PageTrack[]): PageTrack | undefined {
  const zh = tracks.filter((track) => track.languageCode.toLowerCase().startsWith('zh'));
  const rank = (track: PageTrack): number => {
    const at = ZH_PREFERENCE.findIndex((code) => code.toLowerCase() === track.languageCode.toLowerCase());
    return (track.kind === 'asr' ? 100 : 0) + (at === -1 ? 50 : at);
  };
  return [...zh].sort((a, b) => rank(a) - rank(b))[0];
}

export function pickEnglish(tracks: readonly PageTrack[]): PageTrack | undefined {
  const en = tracks.filter((track) => track.languageCode.toLowerCase().startsWith('en'));
  return [...en].sort((a, b) => Number(a.kind === 'asr') - Number(b.kind === 'asr'))[0];
}

/**
 * The track's own URL, with the signing parameters borrowed from a URL the
 * player signed itself, asking for json3 and, optionally, YouTube's machine
 * translation into `tlang`.
 */
export function timedtextUrl(baseUrl: string, signed: string | null, tlang?: string): string {
  const url = new URL(baseUrl);
  if (signed) {
    const from = new URL(signed);
    for (const [key, value] of from.searchParams) {
      if (['lang', 'kind', 'name', 'tlang', 'fmt', 'v'].includes(key)) continue;
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    }
  }
  url.searchParams.set('fmt', 'json3');
  if (tlang) url.searchParams.set('tlang', tlang);
  else url.searchParams.delete('tlang');
  return url.href;
}

async function fetchCues(url: string): Promise<Cue[]> {
  const { status, body } = await askPage<{ status: number; body: string }>('yt-fetch', { url });
  if (status !== 200 || !body.trim()) return [];
  try {
    return parseJson3(body);
  } catch {
    return [];
  }
}

export class YouTubeAdapter implements SiteAdapter {
  readonly site = 'youtube';
  private styleEl: HTMLStyleElement | null = null;

  container(): HTMLElement | null {
    return document.getElementById('movie_player');
  }

  player(): Player | null {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video');
    return video ? new Html5Player(video) : null;
  }

  episodeId(): string | null {
    if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
    const short = /^\/(?:shorts|live)\/([\w-]+)/.exec(location.pathname);
    return short?.[1] ?? null;
  }

  async loadTracks(): Promise<EpisodeTracks> {
    // The player's response lags the URL on in-app navigation; wait for it to catch up.
    const wanted = this.episodeId();
    let info = await askPage<PageTracks>('yt-tracks');
    for (let tries = 0; tries < 20 && info.videoId !== wanted; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      info = await askPage<PageTracks>('yt-tracks');
    }
    const zhTrack = pickChinese(info.tracks);
    if (!zhTrack) {
      throw new Error(
        'This video has no Chinese subtitle track. If the Chinese is burned into the picture, Kànjù can’t read it yet.',
      );
    }
    const enTrack = pickEnglish(info.tracks);

    let signed: string | null = null;
    let zh = await fetchCues(timedtextUrl(zhTrack.baseUrl, null));
    if (zh.length === 0) {
      ({ url: signed } = await askPage<{ url: string | null }>('yt-sign', { languageCode: zhTrack.languageCode }, 10_000));
      zh = await fetchCues(timedtextUrl(zhTrack.baseUrl, signed));
    }
    if (zh.length === 0) throw new Error('YouTube didn’t return the Chinese subtitles. Try turning captions on once, then reload.');

    let en: Cue[] = [];
    let enLabel = '';
    if (enTrack) {
      en = await fetchCues(timedtextUrl(enTrack.baseUrl, signed));
      enLabel = enTrack.name;
    }
    if (en.length === 0) {
      en = await fetchCues(timedtextUrl(zhTrack.baseUrl, signed, 'en'));
      enLabel = en.length > 0 ? 'English (YouTube auto-translate)' : 'none';
    }

    return {
      episodeId: info.videoId ?? this.episodeId() ?? 'unknown',
      title: info.title,
      zh,
      en,
      zhLabel: zhTrack.name + (zhTrack.kind === 'asr' ? ' (auto-generated)' : ''),
      enLabel,
    };
  }

  watchNavigation(onChange: () => void): void {
    document.addEventListener('yt-navigate-finish', onChange);
  }

  hideNativeSubtitles(hidden: boolean): void {
    if (hidden && !this.styleEl) {
      this.styleEl = document.createElement('style');
      this.styleEl.textContent = '#movie_player .ytp-caption-window-container { display: none !important; }';
      document.head.append(this.styleEl);
    } else if (!hidden && this.styleEl) {
      this.styleEl.remove();
      this.styleEl = null;
    }
  }
}
