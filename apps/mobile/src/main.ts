import { Application } from '@nativescript/core';
import { createApp, registerElement } from 'nativescript-vue';

import App from './App.vue';
import { BilibiliView, nativeHost } from './host.ts';

import './app.css';

registerElement('BilibiliView', () => BilibiliView);
Application.android.on('activityBackPressed', event => {
  if (nativeHost().back()) {
    (event as { cancel: boolean }).cancel = true;
  }
});
createApp(App).start();
