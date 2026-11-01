<script setup lang="ts">
import { snapshotSchema } from '@bplaylist/shared';
import type { PlaylistNode, PlayerSnapshot } from '@bplaylist/shared';
import { videoMetadataSchema } from '@bplaylist/shared/bilibili';
import {
  appendResultSchema,
  groupOptionsSchema,
  playlistOptionsSchema,
} from '@bplaylist/shared/bridge';
import { captureActivation, uiRootKey } from '@bplaylist/ui/interaction';
import ItemEditor from '@bplaylist/ui/ItemEditor.vue';
import ThemeToaster from '@bplaylist/ui/ThemeToaster.vue';
import ActionButton from '@bplaylist/ui/ui/ActionButton.vue';
import ModalDialog from '@bplaylist/ui/ui/ModalDialog.vue';
import SelectField from '@bplaylist/ui/ui/SelectField.vue';
import { ListPlus } from '@lucide/vue';
import { computed, inject, ref, watch } from 'vue';
import { toast } from 'vue-sonner';

import { request } from '../lib/messages.ts';
import { useExtensionTheme } from '../lib/theme.ts';

const theme = useExtensionTheme();
const root = inject(uiRootKey);
watch(
  theme,
  value => {
    if (root) {
      root.dataset.theme = value;
    }
  },
  { immediate: true },
);
const open = ref(false);
const ready = ref(false);
const busy = ref(false);
const groupLoading = ref(false);
const error = ref('');
const snapshot = ref<PlayerSnapshot>();
const playlists = ref<{ id: string; title: string; active: boolean }[]>([]);
const selectedId = ref('');
const groups = ref<{ id: string; title: string }[]>([]);

const destinationOptions = computed(() =>
  playlists.value.map(item => ({ value: item.id, label: item.title })),
);

let generation = 0;

async function capture() {
  const result = await request({ action: 'capture' }, snapshotSchema);
  snapshot.value = result;
  return result;
}

async function load() {
  const current = ++generation;
  const isCurrent = () => open.value && current === generation;
  open.value = true;
  ready.value = false;
  error.value = '';

  try {
    const [list, currentVideo] = await Promise.all([
      request({ action: 'list' }, playlistOptionsSchema),
      capture(),
    ]);

    if (!isCurrent()) {
      return;
    }

    playlists.value = list;
    snapshot.value = currentVideo;
    selectedId.value = list.find(item => item.active)?.id ?? list[0]?.id ?? '';

    if (!selectedId.value) {
      throw new Error('桌面端暂无播放列表，请先创建一个');
    }

    groups.value = await request(
      { action: 'groups', playlistId: selectedId.value },
      groupOptionsSchema,
    );

    if (isCurrent()) {
      ready.value = true;
    }
  } catch (cause) {
    if (isCurrent()) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

function close() {
  open.value = false;
  generation++;
}

async function selectDestination(id: string) {
  selectedId.value = id;
  groups.value = [];
  groupLoading.value = true;

  try {
    const result = await request({ action: 'groups', playlistId: id }, groupOptionsSchema);

    if (selectedId.value === id) {
      groups.value = result;
    }
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : String(cause));
  } finally {
    if (selectedId.value === id) {
      groupLoading.value = false;
    }
  }
}

async function saveNodes(nodes: PlaylistNode[]) {
  busy.value = true;

  try {
    const result = await request(
      { action: 'append', input: { playlistId: selectedId.value, nodes } },
      appendResultSchema,
    );

    toast.success(
      `已添加到 ${playlists.value.find(item => item.id === result.playlistId)?.title ?? '播放列表'}`,
    );
    return true;
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : String(cause));
    return false;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div
    :data-theme="theme"
    class="text-foreground inline-flex items-center font-sans text-xs"
    @click.capture="captureActivation"
  >
    <ActionButton
      aria-label="添加到 BPlaylist"
      title="添加到 BPlaylist"
      class="text-muted h-10 gap-1.5 px-3 py-0 text-sm whitespace-nowrap"
      @click="load"
      ><ListPlus :size="24" /><span>BPlaylist</span></ActionButton
    >
    <ItemEditor
      v-if="open && ready"
      kind="video"
      prefill
      :snapshot="snapshot"
      :groups="groups"
      :busy="busy || groupLoading"
      :capture-video="capture"
      :resolve-video="url => request({ action: 'resolve', url }, videoMetadataSchema)"
      :save-nodes="saveNodes"
      @close="close"
    >
      <template #destination
        ><SelectField
          label="添加到播放列表"
          :model-value="selectedId"
          :options="destinationOptions"
          :disabled="busy || groupLoading"
          @update:model-value="selectDestination"
      /></template>
    </ItemEditor>
    <ModalDialog v-else-if="open" title="添加到 BPlaylist" @close="close">
      <p class="text-muted leading-6" role="status">{{ error || '正在读取视频和播放列表…' }}</p>
      <template v-if="error" #footer
        ><ActionButton @click="close">关闭</ActionButton
        ><ActionButton
          class="bg-accent text-surface hover:bg-heading hover:text-surface"
          @click="load"
          >重试</ActionButton
        ></template
      >
    </ModalDialog>
    <ThemeToaster />
  </div>
</template>
