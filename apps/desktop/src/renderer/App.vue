<script setup lang="ts">
import { activeDialog, captureActivation } from '@bplaylist/ui/interaction';
import { theme } from '@bplaylist/ui/theme';
import ThemeToaster from '@bplaylist/ui/ThemeToaster.vue';
import ActionButton from '@bplaylist/ui/ui/ActionButton.vue';
import {
  ArrowLeft,
  ArrowRight,
  Cloud,
  Globe,
  Maximize,
  Plug,
  Sun,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
} from '@lucide/vue';
import { useIntervalFn, useLocalStorage, useTimeoutFn } from '@vueuse/core';
import { ref, useTemplateRef, watch } from 'vue';

import BrowserDialog from './components/BrowserDialog.vue';
import BrowserPane from './components/BrowserPane.vue';
import PlaylistPanel from './components/PlaylistPanel.vue';
import RemoteDialog from './components/RemoteDialog.vue';
import WindowControls from './components/WindowControls.vue';
import { rpc } from './rpc.ts';
import { useWorkspace } from './stores/workspace.ts';

const collapsed = useLocalStorage('bplaylist:panel-collapsed', false);
const workspace = useWorkspace();
const api = { rpc };
const browser = useTemplateRef<InstanceType<typeof BrowserPane>>('browser');
const address = ref('https://www.bilibili.com');
const currentAddress = ref(address.value);
const loading = ref(true);
const remoteOpen = ref(false);
const browserOpen = ref(false);
const chromeRevealed = ref(false);
const addressFocused = ref(false);
let readingPointer = false;

// Native drag regions and the guest do not reliably deliver renderer pointer events.
useIntervalFn(async () => {
  if (!workspace.immersive || readingPointer) {
    return;
  }

  readingPointer = true;

  try {
    const state = await rpc.windowState();

    if (!workspace.immersive) {
      return;
    }

    if (state.pointer && state.pointer.y <= (chromeRevealed.value ? 56 : 20)) {
      revealChrome();
    } else if (chromeRevealed.value && !hidingChrome.value) {
      hideChrome();
    }
  } catch {
    // Connection failures are reported by the workspace poll.
  } finally {
    readingPointer = false;
  }
}, 100);

const {
  start: hideChrome,
  stop: keepChrome,
  isPending: hidingChrome,
} = useTimeoutFn(
  () => {
    if (!addressFocused.value) {
      chromeRevealed.value = false;
    }
  },
  300,
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

  chromeRevealed.value = true;
}

function toggleImmersive() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  void workspace.perform(() => rpc.immersive(!workspace.immersive));
}

function updateLocation(url: string) {
  currentAddress.value = url;

  if (!addressFocused.value) {
    address.value = url;
  }
}

function cancelAddress(event: KeyboardEvent) {
  address.value = currentAddress.value;
  (event.target as HTMLInputElement).blur();
}

function escapeImmersive(event: KeyboardEvent) {
  if (event.defaultPrevented || document.fullscreenElement || activeDialog.value?.open) {
    return;
  }

  if (workspace.immersive) {
    toggleImmersive();
  }
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
    @keydown.esc="escapeImmersive"
  >
    <Transition
      enter-active-class="transition-[opacity,translate] duration-140 ease-out motion-reduce:transition-none"
      enter-from-class="-translate-y-1.5 opacity-0"
      leave-active-class="transition-[opacity,translate] duration-100 ease-in motion-reduce:transition-none"
      leave-to-class="-translate-y-1.5 opacity-0"
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
          class="border-border bg-panel focus-within:border-dim focus-within:ring-border mx-2 flex w-[260px] max-w-[760px] min-w-0 shrink items-center gap-2 rounded-md border px-2.5 transition-[width,flex-grow,border-color,box-shadow] duration-160 ease-out [-webkit-app-region:no-drag] focus-within:ring-1 motion-reduce:transition-none"
          :class="addressFocused ? 'flex-[1_1_260px]' : 'flex-[0_1_260px]'"
          @submit.prevent="navigate"
        >
          <Globe :size="11" class="text-dim shrink-0" /><input
            v-model="address"
            aria-label="B 站网址"
            class="text-muted h-6 w-full min-w-0 bg-transparent text-[10px] outline-none"
            @focus="addressFocused = true"
            @blur="addressFocused = false"
            @keydown.esc.stop.prevent="cancelAddress"
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
            aria-label="连接浏览器插件"
            title="连接浏览器插件"
            class="h-[39px] w-[46px] rounded-none border-0 p-0 active:scale-100"
            @click="browserOpen = true"
            ><Plug :size="14" /></ActionButton
          ><ActionButton
            :aria-label="theme === 'dark' ? '切换白色主题' : '切换黑色主题'"
            :title="theme === 'dark' ? '切换白色主题' : '切换黑色主题'"
            class="h-[39px] w-[46px] rounded-none border-0 p-0 active:scale-100"
            @click="theme = theme === 'dark' ? 'light' : 'dark'"
            ><Sun v-if="theme === 'dark'" :size="14" /><Moon v-else :size="14" /></ActionButton
          ><ActionButton
            :aria-label="collapsed ? '展开播放列表' : '折叠播放列表'"
            class="h-[39px] w-[46px] rounded-none border-0 p-0 active:scale-100"
            @click="collapsed = !collapsed"
            ><PanelRightOpen v-if="collapsed" :size="14" /><PanelRightClose v-else :size="14"
          /></ActionButton>
        </div>
        <WindowControls :maximized="workspace.maximized" />
      </header>
    </Transition>
    <div class="relative flex min-h-0 flex-1">
      <BrowserPane
        ref="browser"
        @location="updateLocation"
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
          class="flex min-h-0 w-[380px] shrink-0 flex-col overflow-hidden transition-[padding-top] duration-140 ease-out motion-reduce:transition-none"
          :style="{ paddingTop: workspace.immersive && chromeRevealed ? '40px' : '0px' }"
        >
          <PlaylistPanel /></div
      ></Transition>
    </div>
    <div
      v-if="workspace.immersive && !chromeRevealed"
      aria-hidden="true"
      class="fixed inset-x-0 top-0 z-40 h-5"
      @pointerenter="revealChrome"
      @pointermove="revealChrome"
    />
    <BrowserDialog v-if="browserOpen" @close="browserOpen = false" />
    <RemoteDialog v-if="remoteOpen" @close="remoteOpen = false" />
    <ThemeToaster />
  </main>
</template>
