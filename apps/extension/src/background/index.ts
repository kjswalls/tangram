/**
 * The background service worker. It owns the dictionary (one copy for every
 * tab) and, from the AI milestone on, the Claude key and its request queue —
 * the page and the content scripts never see the key.
 */
import { Dictionary, type CompactDict } from '../core/dict';
import type { AnnotateResponse, ErrorResponse } from '../core/types';
import type { BackgroundRequest } from '../content/messages';

let dictionary: Promise<Dictionary> | undefined;

function getDictionary(): Promise<Dictionary> {
  dictionary ??= fetch(chrome.runtime.getURL('dict.json'))
    .then((response) => response.json() as Promise<CompactDict>)
    .then((data) => new Dictionary(data));
  return dictionary;
}

async function handle(request: BackgroundRequest): Promise<unknown> {
  switch (request.type) {
    case 'annotate': {
      const dict = await getDictionary();
      return { ok: true, lines: dict.annotate(request.zh) } satisfies AnnotateResponse;
    }
    case 'lookup': {
      const dict = await getDictionary();
      return { ok: true, readings: dict.lookup(request.word) };
    }
  }
}

chrome.runtime.onMessage.addListener((request: BackgroundRequest, _sender, sendResponse) => {
  handle(request)
    .then(sendResponse)
    .catch((error: unknown) =>
      sendResponse({ ok: false, error: String(error) } satisfies ErrorResponse),
    );
  return true;
});

// Warm the dictionary on install so the first episode doesn't wait on it.
chrome.runtime.onInstalled.addListener(() => {
  void getDictionary();
});
