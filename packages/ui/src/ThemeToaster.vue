<script setup lang="ts">
import { inject } from 'vue';
import { Toaster } from 'vue-sonner';

import { activeDialog, uiRootKey } from './interaction.ts';
import { theme } from './theme';
const root = inject(uiRootKey, undefined);
</script>
<template>
  <Teleport :to="activeDialog ?? root ?? 'body'">
    <Toaster
      :theme="theme"
      position="bottom-center"
      :offset="24"
      :duration="4000"
      close-button
      :toast-options="{
        style: {
          background: 'var(--color-raised)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-foreground)',
          fontFamily: 'var(--font-sans)',
          fontSize: '12px',
          borderRadius: '8px',
          padding: '12px 14px',
          gap: '10px',
          boxShadow: '0 8px 30px #0003',
        },
      }"
    />
  </Teleport>
</template>
