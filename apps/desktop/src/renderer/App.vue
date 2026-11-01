<script setup lang="ts">
import {
  ArrowLeft,
  ArrowRight,
  Cloud,
  Globe,
  Maximize,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
} from '@lucide/vue';
import { useIntervalFn, useLocalStorage, useTimeoutFn } from '@vueuse/core';
import { ref, useTemplateRef, watch } from 'vue';
import { Toaster } from 'vue-sonner';

import BrowserPane from './components/BrowserPane.vue';
import PlaylistPanel from './components/PlaylistPanel.vue';
import RemoteDialog from './components/RemoteDialog.vue';
import ActionButton from './components/ui/ActionButton.vue';
import WindowControls from './components/WindowControls.vue';
import { activeDialog, captureActivation } from './lib/interaction.ts';
import { rpc } from './rpc.ts';
import { useWorkspace } from './stores/workspace.ts';

const collapsed = useLocalStorage('bplaylist:panel-collapsed', false);
const workspace = useWorkspace();
const api = { rpc };
const browser = useTemplateRef<InstanceType<typeof BrowserPane>>('browser');
const address = ref('https://www.bilibili.com');
const loading = ref(true);
const remoteOpen = ref(false);
const chromeRevealed = ref(false);
const addressFocused = ref(false);
let guestPointer: number | undefined;
let readingPointer = false;

// Guest pointer events do not bubble through the webview into this document.
useIntervalFn(async () => {
  if (!workspace.immersive || !chromeRevealed.value || readingPointer) {
    return;
  }

  readingPointer = true;

  try {
    const state = await rpc.windowState();

    if (guestPointer !== undefined && state.guestPointer !== guestPointer) {
      hideChrome();
    }

    guestPointer = state.guestPointer;
  } catch {
    // Connection failures are reported by the workspace poll.
  } finally {
    readingPointer = false;
  }
}, 100);

const { start: hideChrome, stop: keepChrome } = useTimeoutFn(
  () => {
    if (!addressFocused.value) {
      chromeRevealed.value = false;
    }
  },
  220,
  { immediate: false },
);

watch(
  () => workspace.immersive,
  () => {
    keepChrome();
    chromeRevealed.value = false;

    if (workspace.immersive) {
      collapsed.value = true;
    }
  },
);

function revealChrome() {
  keepChrome();

  if (!chromeRevealed.value) {
    guestPointer = undefined;
  }

  chromeRevealed.value = true;
}

function toggleImmersive() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  void workspace.perform(() => rpc.immersive(!workspace.immersive));
}

function navigate() {
  void workspace.perform(() => rpc.navigate(address.value));
}
</script>

<template>
  <main
    aria-label="BPlaylist 工作区"
    class="relative flex h-screen flex-col overflow-hidden"
    @click.capture="captureActivation"
  >
    <header
      v-show="!workspace.immersive || chromeRevealed"
      class="border-border bg-surface z-40 flex h-10 shrink-0 items-center border-b pl-4 [-webkit-app-region:drag]"
      :class="workspace.immersive ? 'absolute inset-x-0 top-0 shadow-lg' : ''"
      @pointerenter="revealChrome"
      @pointerleave="hideChrome()"
      @focusin="revealChrome"
      @focusout="hideChrome()"
      @dblclick.self="api.rpc.windowControl('maximize')"
    >
      <nav class="flex items-center [-webkit-app-region:no-drag]" aria-label="网页导航">
        <ActionButton aria-label="后退" class="p-1.5" @click="browser?.back()"
          ><ArrowLeft :size="13" /></ActionButton
        ><ActionButton aria-label="前进" class="p-1.5" @click="browser?.forward()"
          ><ArrowRight :size="13" /></ActionButton
        ><ActionButton aria-label="刷新网页" class="p-1.5" @click="browser?.reload()"
          ><RefreshCw :size="12" :class="loading ? 'animate-spin' : ''"
        /></ActionButton>
      </nav>
      <form
        class="border-border bg-panel focus-within:border-dim focus-within:ring-border mx-2 flex max-w-[760px] min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5 transition-[border-color,box-shadow] duration-100 [-webkit-app-region:no-drag] focus-within:ring-1"
        @submit.prevent="navigate"
      >
        <Globe :size="11" class="text-dim shrink-0" /><input
          v-model="address"
          aria-label="B 站网址"
          class="text-muted h-6 w-full min-w-0 bg-transparent text-[10px] outline-none"
          @focus="addressFocused = true"
          @blur="addressFocused = false"
        />
      </form>
      <div
        data-header-actions
        class="ml-auto flex h-[39px] shrink-0 items-start self-start pt-px [-webkit-app-region:no-drag]"
      >
        <ActionButton
          :aria-label="workspace.immersive ? '退出沉浸模式' : '进入沉浸模式'"
          :title="workspace.immersive ? '退出沉浸模式 · Esc / F11' : '沉浸模式 · F11'"
          class="h-[39px] w-[46px] rounded-none border-0 p-0 active:scale-100"
          @click="toggleImmersive"
          ><Maximize :size="14" /></ActionButton
        ><ActionButton
          aria-label="远程导入导出"
          class="h-[39px] w-[46px] rounded-none border-0 p-0 active:scale-100"
          @click="remoteOpen = true"
          ><Cloud :size="14" /></ActionButton
        ><ActionButton
          :aria-label="collapsed ? '展开播放列表' : '折叠播放列表'"
          class="h-[39px] w-[46px] rounded-none border-0 p-0 active:scale-100"
          @click="collapsed = !collapsed"
          ><PanelRightOpen v-if="collapsed" :size="14" /><PanelRightClose v-else :size="14"
        /></ActionButton>
      </div>
      <WindowControls :maximized="workspace.maximized" />
    </header>
    <div class="relative flex min-h-0 flex-1">
      <BrowserPane
        ref="browser"
        @location="address = $event"
        @loading="loading = $event"
      /><Transition
        enter-active-class="transition-[width,opacity] duration-160 ease-out motion-reduce:transition-none"
        enter-from-class="w-0! opacity-0"
        enter-to-class="w-[380px] opacity-100"
        leave-active-class="transition-[width,opacity] duration-120 ease-in motion-reduce:transition-none"
        leave-from-class="w-[380px] opacity-100"
        leave-to-class="w-0! opacity-0"
        ><div
          v-if="!collapsed"
          class="h-full w-[380px] shrink-0 overflow-hidden"
          :class="workspace.immersive && chromeRevealed ? 'pt-10' : ''"
        >
          <PlaylistPanel /></div
      ></Transition>
    </div>
    <div
      v-if="workspace.immersive && !chromeRevealed"
      aria-hidden="true"
      class="fixed inset-x-0 top-0 z-40 h-3"
      @pointerenter="revealChrome"
    />
    <RemoteDialog v-if="remoteOpen" @close="remoteOpen = false" />
    <Teleport :to="activeDialog ?? 'body'">
      <Toaster
        theme="dark"
        position="bottom-center"
        :offset="24"
        :duration="4000"
        close-button
        :toast-options="{
          style: {
            background: '#1b1b1b',
            border: '1px solid #333333',
            color: '#d0d0d0',
            fontFamily: 'var(--font-sans)',
            fontSize: '12px',
            borderRadius: '8px',
            padding: '12px 14px',
            gap: '10px',
            transition: 'transform 160ms ease-out, opacity 120ms ease-out, height 160ms ease-out',
            boxShadow: '0 8px 30px #0006',
          },
        }"
      />
    </Teleport>
  </main>
</template>
