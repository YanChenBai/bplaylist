import type { NativeScriptConfig } from '@nativescript/core';

export default {
  id: 'com.bplaylist.mobile',
  appPath: 'src',
  appResourcesPath: 'App_Resources',
  bundler: 'vite',
  bundlerConfigPath: 'vite.config.mts',
  cli: { packageManager: 'pnpm' },
  android: { v8Flags: '--expose_gc', markingMode: 'none' },
} satisfies NativeScriptConfig;
