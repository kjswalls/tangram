/**
 * The MAIN-world ↔ content-script channel. Page scripts run in the site's own
 * JavaScript world (they can read the player and wrap `fetch`); content scripts
 * run isolated (they can reach `chrome.*`). They talk over `window.postMessage`,
 * tagged so nothing else on the page is mistaken for Kànjù.
 */
export const TAG = 'kanju';

export interface BridgeMessage {
  tag: typeof TAG;
  direction: 'to-page' | 'to-content';
  id?: number;
  kind: string;
  payload?: unknown;
}

export function post(direction: BridgeMessage['direction'], kind: string, payload?: unknown, id?: number): void {
  window.postMessage({ tag: TAG, direction, kind, payload, id } satisfies BridgeMessage, '*');
}

export function isBridgeMessage(data: unknown, direction: BridgeMessage['direction']): data is BridgeMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as BridgeMessage).tag === TAG &&
    (data as BridgeMessage).direction === direction
  );
}

let nextId = 1;

/** Content side: ask the page script something and wait for its answer. */
export function askPage<T>(kind: string, payload?: unknown, timeoutMs = 8000): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error(`page did not answer ${kind}`));
    }, timeoutMs);
    function onMessage(event: MessageEvent): void {
      if (event.source !== window || !isBridgeMessage(event.data, 'to-content')) return;
      if (event.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      const payload = event.data.payload as { error?: string } | undefined;
      if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
        reject(new Error(payload.error));
      } else {
        resolve(event.data.payload as T);
      }
    }
    window.addEventListener('message', onMessage);
    post('to-page', kind, payload, id);
  });
}

/** Page side: answer the content script's questions. */
export function servePage(handlers: Record<string, (payload: unknown) => unknown>): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || !isBridgeMessage(event.data, 'to-page')) return;
    const { kind, payload, id } = event.data;
    const handler = handlers[kind];
    if (!handler) return;
    Promise.resolve()
      .then(() => handler(payload))
      .then(
        (result) => post('to-content', kind, result, id),
        (error: unknown) => post('to-content', kind, { error: String(error) }, id),
      );
  });
}
