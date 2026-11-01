<script setup lang="ts">
import type { WebviewTag } from 'electron';
import { onMounted, ref, useTemplateRef } from 'vue';
import { toast } from 'vue-sonner';

const emit = defineEmits<{ location: [url: string]; loading: [loading: boolean] }>();
const webview = useTemplateRef<WebviewTag>('webview');
const screenFullscreen = ref(false);

onMounted(() => {
  const guest = webview.value;

  if (!guest) {
    return;
  }

  guest.addEventListener('enter-html-full-screen', () => {
    screenFullscreen.value = true;
  });
  guest.addEventListener('leave-html-full-screen', () => {
    screenFullscreen.value = false;
  });

  guest.addEventListener('did-start-loading', () => {
    emit('loading', true);
  });
  guest.addEventListener('did-stop-loading', () => {
    emit('loading', false);
    emit('location', guest.getURL());
  });
  guest.addEventListener('did-navigate-in-page', () => emit('location', guest.getURL()));
  guest.addEventListener('did-fail-load', event => {
    if (event.isMainFrame && event.errorCode !== -3) {
      toast.error(`页面加载失败：${event.errorDescription}`, { id: 'browser-error' });
      emit('loading', false);
    }
  });
});

defineExpose({
  back: () => {
    if (webview.value?.canGoBack()) {
      webview.value.goBack();
    }
  },
  forward: () => {
    if (webview.value?.canGoForward()) {
      webview.value.goForward();
    }
  },
  reload: () => webview.value?.reload(),
});
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col" aria-label="B 站浏览器">
    <webview
      ref="webview"
      src="https://www.bilibili.com"
      partition="persist:bilibili"
      allowpopups
      class="flex min-h-0 w-full flex-1"
      :class="screenFullscreen ? 'fixed! inset-0! z-50! h-screen! w-screen! flex-none!' : ''"
    />
  </section>
</template>
