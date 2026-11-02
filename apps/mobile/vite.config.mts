// oxlint-disable-next-line vite-plus/prefer-vite-plus-imports
import { defineConfig, mergeConfig } from 'vite';

export default defineConfig(async ({ mode }) => {
  if (!process.env.NATIVESCRIPT_BUNDLER_ENV) {
    return {};
  }

  const { vueConfig } = await import('@nativescript/vite/vue');

  return mergeConfig(vueConfig({ mode }), {
    resolve: { preserveSymlinks: false },
  });
});
