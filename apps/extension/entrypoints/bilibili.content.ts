import { uiRootKey } from '@bplaylist/ui/interaction';
import { createApp } from 'vue';

import App from '../components/AddToPlaylist.vue';

import 'vue-sonner/style.css';
import '../assets/style.css';

export default defineContentScript({
  matches: ['https://www.bilibili.com/*'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    const anchor = () => {
      if (!/^\/(video\/|bangumi\/play\/)/.test(location.pathname)) {
        return null;
      }

      const share = document.querySelector(
        '.video-toolbar-left .video-toolbar-share, .video-toolbar-left .video-share, .video-toolbar-left .share, #share-container',
      );

      const toolbar = share?.closest('.video-toolbar-left');

      if (!toolbar) {
        return share;
      }

      let item = share;

      while (item?.parentElement && item.parentElement !== toolbar) {
        item = item.parentElement;
      }

      return item;
    };

    const ui = await createShadowRootUi(ctx, {
      name: 'bplaylist-add',
      position: 'inline',
      anchor,
      append: 'after',
      onMount(container) {
        const app = createApp(App);
        app.provide(uiRootKey, container);
        app.mount(container);
        return app;
      },
      onRemove: app => app?.unmount(),
    });

    Object.assign(ui.shadowHost.style, {
      display: 'inline-flex',
      alignItems: 'center',
      alignSelf: 'center',
      flex: '0 0 auto',
      marginLeft: '16px',
      verticalAlign: 'middle',
    });
    let current: Element | null = null;

    function reconcile() {
      const next = anchor();

      if (next === current && (!next || ui.shadowHost.isConnected)) {
        return;
      }

      ui.remove();
      current = next;

      if (next) {
        ui.mount();
      }
    }

    const observer = new MutationObserver(reconcile);
    observer.observe(document.body, { childList: true, subtree: true });
    ctx.addEventListener(window, 'wxt:locationchange', reconcile);
    ctx.onInvalidated(() => {
      observer.disconnect();
      ui.remove();
    });
    reconcile();
  },
});
