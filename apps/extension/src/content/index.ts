/**
 * The content script (isolated world). Picks the site adapter, mounts the card
 * and the sidebar in their own shadow roots so the site's CSS can't reach them,
 * and wires keys and navigation to the controller.
 */
import { h, render } from 'preact';

import { Controller } from '../ui/controller';
import { Card, Sidebar } from '../ui/components';
import { initialState, loadSettings, Store } from '../ui/store';
import css from '../ui/styles.css';
import { YouTubeAdapter } from './adapters/youtube';
import type { SiteAdapter } from './adapters/types';

function adapterFor(host: string): SiteAdapter | null {
  if (host === 'www.youtube.com' || host === 'm.youtube.com') return new YouTubeAdapter();
  return null;
}

function shadowHost(id: string): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement('kanju-root');
  host.id = id;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  root.append(style);
  return { host, root };
}

async function main(): Promise<void> {
  const adapter = adapterFor(location.hostname);
  if (!adapter) return;

  const store = new Store(initialState(await loadSettings()));
  const controller = new Controller(store, adapter);

  const card = shadowHost('kanju-card');
  card.host.setAttribute('style', 'position:absolute;inset:0;pointer-events:none;z-index:60;');
  render(h(Card, { controller }), card.root);

  const sidebar = shadowHost('kanju-sidebar');
  sidebar.host.setAttribute('style', 'position:fixed;top:0;right:0;bottom:0;z-index:2147483000;pointer-events:none;');
  render(h(Sidebar, { controller }), sidebar.root);
  document.documentElement.append(sidebar.host);

  // The site may rebuild its player; keep the card inside whatever is current.
  const keepMounted = (): void => {
    const container = adapter.container();
    if (container && card.host.parentElement !== container) container.append(card.host);
  };
  keepMounted();
  setInterval(keepMounted, 1000);

  window.addEventListener(
    'keydown',
    (event) => {
      if (store.state.status !== 'ready') return;
      if (controller.handleKey(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  document.addEventListener('click', () => controller.closePopover());

  adapter.watchNavigation(() => {
    keepMounted();
    void controller.load();
  });
  controller.start();
  await controller.load();
  // Some navigations don't fire the site's event (back/forward caches, embeds): check on a timer too.
  setInterval(() => void controller.load(), 2000);
}

void main();
