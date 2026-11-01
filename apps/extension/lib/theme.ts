import { theme, themeSchema } from '@bplaylist/ui/theme';
import { onMounted, onUnmounted, watch } from 'vue';
import { browser } from 'wxt/browser';

export function useExtensionTheme() {
  watch(theme, value => {
    void browser.storage.local.set({ theme: value });
  });

  const changed: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, area) => {
    const parsed = themeSchema.safeParse(changes.theme?.newValue);

    if (area === 'local' && parsed.success) {
      theme.value = parsed.data;
    }
  };

  onMounted(async () => {
    browser.storage.onChanged.addListener(changed);
    const parsed = themeSchema.safeParse((await browser.storage.local.get('theme')).theme);

    if (parsed.success) {
      theme.value = parsed.data;
    }
  });
  onUnmounted(() => browser.storage.onChanged.removeListener(changed));
  return theme;
}
