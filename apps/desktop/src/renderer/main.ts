import { theme, themeSchema } from '@bplaylist/ui/theme';
import { PiniaColada } from '@pinia/colada';
import { createPinia } from 'pinia';
import { createApp, watch } from 'vue';

import App from './App.vue';

import 'vue-sonner/style.css';
import './style.css';

const storedTheme = themeSchema.safeParse(localStorage.getItem('bplaylist:theme'));

if (storedTheme.success) {
  theme.value = storedTheme.data;
}

watch(
  theme,
  value => {
    document.documentElement.dataset.theme = value;
    localStorage.setItem('bplaylist:theme', value);
  },
  { immediate: true },
);

createApp(App).use(createPinia()).use(PiniaColada).mount('#app');
