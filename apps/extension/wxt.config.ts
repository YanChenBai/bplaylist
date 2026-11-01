import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'BPlaylist',
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    description: '把 B 站视频、分 P 和跨集片段添加到桌面播放列表。',
    permissions: ['storage', 'scripting'],
    host_permissions: ['https://www.bilibili.com/*', 'http://127.0.0.1/*'],
  },
  vite: () => ({
    plugins: [tailwindcss()],
    css: {
      postcss: {
        plugins: [
          {
            postcssPlugin: 'bplaylist-shadow-rem',
            Declaration(declaration) {
              declaration.value = declaration.value.replace(
                /(-?[\d.]+)rem\b/g,
                (_, value) => `${Number(value) * 16}px`,
              );
            },
          },
        ],
      },
    },
  }),
});
