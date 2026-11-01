import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'veldorajs';

export default defineConfig({
  veldora: {
    main: {
      build: {
        externalizeDeps: { exclude: ['@bplaylist/shared', '@bplaylist/bridge'] },
        rolldownOptions: {
          input: './src/main/index.ts',
          output: { format: 'es', entryFileNames: 'index.js' },
        },
      },
    },
    preload: {
      build: {
        rolldownOptions: {
          input: './src/preload/index.ts',
          output: { format: 'es', entryFileNames: 'index.mjs' },
        },
      },
    },
    renderer: {
      plugins: [
        vue({ template: { compilerOptions: { isCustomElement: tag => tag === 'webview' } } }),
        tailwindcss(),
      ],
    },
  },
});
