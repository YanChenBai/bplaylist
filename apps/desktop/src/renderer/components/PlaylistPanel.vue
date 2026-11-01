<script setup lang="ts">
import { movePlaylistNode } from '@bplaylist/shared';
import type { PlaylistNode, DropPosition } from '@bplaylist/shared';
import ActionButton from '@bplaylist/ui/ui/ActionButton.vue';
import ModalDialog from '@bplaylist/ui/ui/ModalDialog.vue';
import SelectField from '@bplaylist/ui/ui/SelectField.vue';
import TextField from '@bplaylist/ui/ui/TextField.vue';
import { FolderPlus, ListVideo, SkipBack, SkipForward, Plus } from '@lucide/vue';
import { ref, useId } from 'vue';

import { rpc } from '../rpc.ts';
import { useWorkspace } from '../stores/workspace.ts';
import ItemContextMenu from './ItemContextMenu.vue';
import ItemEditor from './ItemEditor.vue';
import PlaylistSettings from './PlaylistSettings.vue';
import PlaylistTree from './PlaylistTree.vue';

const workspace = useWorkspace();
const api = { rpc };
const editor = ref<{ kind: 'video' | 'group'; node?: PlaylistNode } | null>(null);
const nameDialog = ref<'create' | 'rename' | null>(null);
const name = ref('');
const removeId = ref<string | null>(null);
const draggingId = ref<string | null>(null);
const nameFormId = useId();
const context = ref<{ node: PlaylistNode; x: number; y: number } | null>(null);

function openContext(node: PlaylistNode, x: number, y: number) {
  context.value = { node, x, y };
}

function editContext() {
  if (context.value) {
    editor.value = { kind: context.value.node.kind, node: context.value.node };
  }

  context.value = null;
}

function removeContext() {
  removeId.value = context.value?.node.id ?? null;
  context.value = null;
}

function play(id?: string) {
  const itemId = id ?? workspace.state?.playlist.activeItemId ?? workspace.queue[0]?.id;

  if (itemId) {
    void workspace.perform(() => rpc.play({ id: itemId, resume: true }));
  }
}

function reorder(id: string, targetId: string, position: DropPosition) {
  draggingId.value = null;
  void workspace.edit(document => {
    document.nodes = movePlaylistNode(document.nodes, id, targetId, position);
  });
}

async function remove() {
  const saved = await workspace.edit(document => {
    const ids = new Set([removeId.value!]);
    let size = 0;

    while (size !== ids.size) {
      size = ids.size;

      for (const node of document.nodes) {
        if (node.parentId && ids.has(node.parentId)) {
          ids.add(node.id);
        }
      }
    }

    document.nodes = document.nodes.filter(node => !ids.has(node.id));
    document.progress = Object.fromEntries(
      Object.entries(document.progress).filter(([id]) => !ids.has(id)),
    );

    if (document.activeItemId && ids.has(document.activeItemId)) {
      document.activeItemId = null;
    }
  });

  if (saved) {
    removeId.value = null;
  }
}

async function saveName() {
  const saved =
    nameDialog.value === 'create'
      ? await workspace.perform(() => rpc.create(name.value))
      : await workspace.edit(document => {
          document.title = name.value;
        });

  if (saved) {
    nameDialog.value = null;
  }
}
</script>

<template>
  <aside
    class="border-border bg-panel flex h-full w-[380px] shrink-0 flex-col border-l"
    aria-label="播放列表"
  >
    <div class="border-border border-b px-3 py-1">
      <div class="flex items-center gap-1">
        <SelectField
          :model-value="workspace.state?.playlist.id ?? ''"
          label="切换播放列表"
          class="min-w-0 flex-1"
          borderless
          :disabled="workspace.busy"
          :options="(workspace.library ?? []).map(list => ({ value: list.id, label: list.title }))"
          @update:model-value="value => workspace.perform(() => api.rpc.select(value))"
        />
        <PlaylistSettings
          @rename="
            name = workspace.state?.playlist.title ?? '';
            nameDialog = 'rename';
          "
        />
        <ActionButton
          aria-label="新建播放列表"
          @click="
            name = '';
            nameDialog = 'create';
          "
          ><Plus :size="14"
        /></ActionButton>
      </div>
    </div>
    <div class="flex items-center justify-between px-3 py-1.5">
      <span class="text-dim pl-px text-[10px] tracking-widest">播放顺序</span>
      <div class="flex items-center gap-0.5">
        <ActionButton
          aria-label="上一项"
          title="上一项"
          class="p-1.5"
          :disabled="workspace.busy || workspace.currentIndex <= 0"
          @click="workspace.perform(() => api.rpc.step(-1))"
          ><SkipBack :size="13"
        /></ActionButton>
        <ActionButton
          aria-label="下一项"
          title="下一项"
          class="mr-1 p-1.5"
          :disabled="workspace.busy || workspace.currentIndex >= workspace.queue.length - 1"
          @click="workspace.perform(() => api.rpc.step(1))"
          ><SkipForward :size="13"
        /></ActionButton>
        <ActionButton aria-label="添加分组" title="添加分组" @click="editor = { kind: 'group' }"
          ><FolderPlus :size="14" /></ActionButton
        ><ActionButton aria-label="添加视频" @click="editor = { kind: 'video' }"
          ><Plus :size="14"
        /></ActionButton>
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-auto px-3 pb-4">
      <PlaylistTree
        :parent-id="null"
        @play="play"
        @context="openContext"
        :dragging-id="draggingId"
        @drag-start="draggingId = $event"
        @drag-end="draggingId = null"
        @reorder="reorder"
      />
      <div
        v-if="!workspace.queue.length && !workspace.state?.playlist.nodes.length"
        class="grid justify-items-center gap-4 px-6 py-16 text-center"
      >
        <ListVideo :size="30" :stroke-width="1" class="text-dim" />
        <h2 class="text-foreground text-sm">把想看的，排在一起</h2>
        <p class="text-dim text-[11px] leading-6">
          打开左侧视频，添加完整视频、分 P 或一段时间。也可以用分组整理你的播放顺序。
        </p>
        <ActionButton class="border-border" @click="editor = { kind: 'video' }"
          ><Plus :size="13" />添加第一个视频</ActionButton
        >
      </div>
    </div>

    <ItemContextMenu
      v-if="context"
      :key="`${context.node.id}:${context.x}:${context.y}`"
      :x="context.x"
      :y="context.y"
      @edit="editContext"
      @remove="removeContext"
      @close="context = null"
    />
    <ItemEditor v-if="editor" :kind="editor.kind" :node="editor.node" @close="editor = null" />
    <ModalDialog
      v-if="nameDialog"
      :title="nameDialog === 'create' ? '新建播放列表' : '重命名播放列表'"
      @close="nameDialog = null"
      ><form :id="nameFormId" class="grid gap-4" @submit.prevent="saveName">
        <TextField v-model="name" label="列表名称" />
      </form>
      <template #footer
        ><span />
        <div class="flex items-center gap-2">
          <ActionButton @click="nameDialog = null">取消</ActionButton
          ><button
            type="submit"
            :form="nameFormId"
            :disabled="workspace.busy || !name.trim()"
            class="bg-accent text-surface rounded-md px-4 py-2 disabled:opacity-40"
          >
            保存
          </button>
        </div></template
      >
    </ModalDialog>
    <ModalDialog v-if="removeId" title="删除条目" @close="removeId = null"
      ><p class="text-muted mb-5 leading-6">删除分组也会删除组内所有条目与进度。</p>
      <template #footer
        ><span />
        <div class="flex justify-end gap-2">
          <ActionButton @click="removeId = null">取消</ActionButton
          ><ActionButton
            class="border-border text-red-300"
            :disabled="workspace.busy"
            @click="remove"
            >确认删除</ActionButton
          >
        </div></template
      ></ModalDialog
    >
  </aside>
</template>
