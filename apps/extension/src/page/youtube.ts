/**
 * YouTube, MAIN world, document_start.
 *
 * YouTube signs its subtitle requests with a proof-of-origin token (`pot`)
 * that only the player can mint, so a timedtext URL built from the caption
 * list alone often comes back empty. This script watches the player's own
 * timedtext requests and remembers the newest signed URL; the content script
 * borrows its signing parameters for every track it needs.
 */
import { servePage } from './bridge';

interface YtCaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  vssId?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
}

interface YtPlayer extends HTMLElement {
  getPlayerResponse?: () => YtPlayerResponse | undefined;
  getVideoData?: () => { video_id?: string; title?: string };
  loadModule?: (name: string) => void;
  unloadModule?: (name: string) => void;
  setOption?: (module: string, option: string, value: unknown) => void;
}

interface YtPlayerResponse {
  videoDetails?: { videoId?: string; title?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: YtCaptionTrack[] } };
}

let signedUrl: string | null = null;

function remember(url: string | URL | Request): void {
  const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
  if (href.includes('/api/timedtext') && href.includes('pot=')) signedUrl = new URL(href, location.href).href;
}

const nativeFetch = window.fetch;
window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
  try {
    remember(input);
  } catch {
    // Never break the page over a URL we couldn't read.
  }
  return nativeFetch.call(this, input, init);
};

const nativeOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  try {
    remember(url);
  } catch {
    // As above.
  }
  return (nativeOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

function player(): YtPlayer | null {
  return document.getElementById('movie_player') as YtPlayer | null;
}

servePage({
  'yt-tracks': () => {
    const p = player();
    const response = p?.getPlayerResponse?.();
    const video = p?.getVideoData?.();
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    return {
      videoId: video?.video_id ?? response?.videoDetails?.videoId ?? null,
      title: video?.title ?? response?.videoDetails?.title ?? document.title,
      tracks: tracks.map((track) => ({
        baseUrl: new URL(track.baseUrl, location.href).href,
        languageCode: track.languageCode,
        kind: track.kind ?? '',
        name: track.name?.simpleText ?? track.name?.runs?.map((run) => run.text).join('') ?? track.languageCode,
      })),
    };
  },

  /** Turn the player's captions on in `languageCode` so it makes a signed request, then wait for it. */
  'yt-sign': async (payload) => {
    const { languageCode } = payload as { languageCode: string };
    if (signedUrl) return { url: signedUrl };
    const p = player();
    p?.loadModule?.('captions');
    p?.setOption?.('captions', 'track', { languageCode });
    for (let waited = 0; waited < 6000 && !signedUrl; waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { url: signedUrl };
  },

  'yt-fetch': async (payload) => {
    const { url } = payload as { url: string };
    const response = await nativeFetch(url, { credentials: 'include' });
    return { status: response.status, body: await response.text() };
  },
});

// A new video invalidates the signature: pot is bound to the video.
document.addEventListener('yt-navigate-start', () => {
  signedUrl = null;
});
