<script setup lang="ts">
import { displayTitle, formatTime, canMovePlaylistNode } from '@bplaylist/shared';
import type { PlaylistNode, DropPosition } from '@bplaylist/shared';
import { GripVertical, Check, ChevronDown, ChevronRight, Folder } from '@lucide/vue';
import { cn } from 'cn';
import { computed, ref } from 'vue';

import { useWorkspace } from '../stores/workspace.ts';
import ActionButton from './ui/ActionButton.vue';

const props = defineProps<{ parentId: string | null; depth?: number; draggingId: string | null }>();

const emit = defineEmits<{
  play: [id: string];
  context: [node: PlaylistNode, x: number, y: number];
  dragStart: [id: string];
  dragEnd: [];
  reorder: [id: string, targetId: string, position: DropPosition];
}>();

const workspace = useWorkspace();
const collapsed = ref(new Set<string>());
const dropTarget = ref<{ id: string; position: DropPosition } | null>(null);

function dragStart(event: DragEvent, node: PlaylistNode) {
  if (!event.dataTransfer || workspace.busy) {
    event.preventDefault();
    return;
  }

  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-bplaylist-item', node.id);
  const row = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-node-id]');

  if (row) {
    event.dataTransfer.setDragImage(row, 12, 16);
  }

  emit('dragStart', node.id);
}

function dragOver(event: DragEvent, node: PlaylistNode) {
  if (
    !props.draggingId ||
    workspace.busy ||
    !canMovePlaylistNode(workspace.state?.playlist.nodes ?? [], props.draggingId, node.id)
  ) {
    return;
  }

  event.preventDefault();
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const ratio = (event.clientY - bounds.top) / bounds.height;
  let position: DropPosition = ratio < 0.5 ? 'before' : 'after';

  if (node.kind === 'group' && ratio > 0.25 && ratio < 0.75) {
    position = 'inside';
  }

  dropTarget.value = { id: node.id, position };

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
}

function dragLeave(event: DragEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
    dropTarget.value = null;
  }
}

function drop(event: DragEvent, node: PlaylistNode) {
  event.preventDefault();

  if (!props.draggingId || dropTarget.value?.id !== node.id) {
    return;
  }

  const position = dropTarget.value.position;

  if (position === 'inside') {
    collapsed.value.delete(node.id);
  }

  emit('reorder', props.draggingId, node.id, position);
  dropTarget.value = null;
}

const nodes = computed(
  () => workspace.state?.playlist.nodes.filter(node => node.parentId === props.parentId) ?? [],
);

function sourceLabel(url: string) {
  const parsed = new URL(url);
  return parsed.pathname.includes('bangumi') ? '分集' : `P${parsed.searchParams.get('p') ?? '1'}`;
}

function detailTitle(node: Extract<PlaylistNode, { kind: 'video' }>) {
  const part = node.partTitle.replace(/^P\s*\d+\s*[·:：-]\s*/i, '').trim();
  return [
    node.alias && node.title !== node.alias ? node.title : '',
    part !== node.title && part !== node.alias ? part : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function toggle(id: string) {
  if (collapsed.value.has(id)) {
    collapsed.value.delete(id);
  } else {
    collapsed.value.add(id);
  }
}
</script>

<template>
  <ul :class="cn('space-y-1', depth && 'border-border ml-[12.5px] border-l pl-2')">
    <li v-for="(node, index) in nodes" :key="node.id">
      <div
        :data-node-id="node.id"
        @contextmenu.prevent.stop="emit('context', node, $event.clientX, $event.clientY)"
        @dragover.stop="dragOver($event, node)"
        @dragleave="dragLeave"
        @drop.stop="drop($event, node)"
        :class="
          cn(
            'group hover:bg-raised/70 relative flex items-center gap-1 rounded-md border border-transparent px-1 py-1.5 transition-[background-color,border-color,opacity] duration-100',
            workspace.state?.playlist.activeItemId === node.id && 'bg-raised border-border',
            draggingId === node.id && 'opacity-40',
            draggingId &&
              dropTarget?.id === node.id &&
              dropTarget.position === 'before' &&
              'before:bg-accent before:absolute before:inset-x-0 before:top-0 before:h-px',
            draggingId &&
              dropTarget?.id === node.id &&
              dropTarget.position === 'after' &&
              'after:bg-accent after:absolute after:inset-x-0 after:bottom-0 after:h-px',
            draggingId &&
              dropTarget?.id === node.id &&
              dropTarget.position === 'inside' &&
              'border-dim bg-raised',
          )
        "
      >
        <button
          type="button"
          :aria-label="`拖拽 ${displayTitle(node)}`"
          :draggable="!workspace.busy"
          :disabled="workspace.busy"
          class="text-dim shrink-0 cursor-grab px-0.5 opacity-30 transition-opacity duration-100 group-hover:opacity-100 active:cursor-grabbing"
          @dragstart.stop="dragStart($event, node)"
          @dragend="
            dropTarget = null;
            emit('dragEnd');
          "
        >
          <GripVertical :size="12" />
        </button>
        <ActionButton
          v-if="node.kind === 'group'"
          :aria-label="`${collapsed.has(node.id) ? '展开' : '折叠'} ${node.title}`"
          class="p-1"
          @click="toggle(node.id)"
          ><ChevronRight v-if="collapsed.has(node.id)" :size="13" /><ChevronDown v-else :size="13"
        /></ActionButton>
        <span v-else class="text-dim w-4 shrink-0 text-center text-[10px] tabular-nums"
          ><Check
            v-if="workspace.state?.playlist.progress[node.id]?.completed"
            :size="13"
            class="text-accent mx-auto"
          /><span v-else>{{ index + 1 }}</span></span
        >
        <button
          class="min-w-0 flex-1 px-1 text-left active:scale-100"
          :title="
            node.kind === 'video'
              ? [node.title, node.partTitle, node.alias].filter(Boolean).join(' · ')
              : node.title
          "
          :aria-label="node.kind === 'video' ? `播放 ${displayTitle(node)}` : node.title"
          @click="node.kind === 'group' ? toggle(node.id) : emit('play', node.id)"
        >
          <span class="flex min-w-0 items-center gap-2"
            ><Folder v-if="node.kind === 'group'" :size="13" class="text-dim shrink-0" /><span
              :class="
                cn(
                  'min-w-0 truncate text-[12px] leading-5',
                  workspace.state?.playlist.activeItemId === node.id
                    ? 'text-accent'
                    : 'text-foreground',
                )
              "
              >{{ node.kind === 'video' ? node.alias || node.title : node.title }}</span
            ></span
          >
          <span
            v-if="node.kind === 'video'"
            class="text-dim mt-0.5 flex min-w-0 items-center gap-2 text-[10px] leading-4"
          >
            <span class="shrink-0">{{ sourceLabel(node.url) }}</span>
            <span v-if="node.continuation" class="shrink-0"
              >→ {{ sourceLabel(node.continuation.at(-1)!.url) }}</span
            >
            <span v-if="detailTitle(node)" class="min-w-0 truncate">{{ detailTitle(node) }}</span>
            <span v-if="node.start || node.end !== null" class="shrink-0 tabular-nums">
              {{ formatTime(node.start) }}–{{ node.end === null ? '结束' : formatTime(node.end) }}
            </span>
            <span
              v-if="workspace.state?.playlist.progress[node.id]"
              class="ml-auto shrink-0 tabular-nums"
            >
              <template v-if="node.continuation"
                >{{
                  sourceLabel(
                    node.continuation[
                      (workspace.state.playlist.progress[node.id]!.segmentIndex ?? 0) - 1
                    ]?.url ?? node.url,
                  )
                }}
                · </template
              >已播 {{ formatTime(workspace.state.playlist.progress[node.id]!.position) }}
            </span>
          </span>
        </button>
      </div>
      <PlaylistTree
        v-if="node.kind === 'group' && !collapsed.has(node.id)"
        :parent-id="node.id"
        :depth="(depth ?? 0) + 1"
        @play="emit('play', $event)"
        @context="(node, x, y) => emit('context', node, x, y)"
        :dragging-id="draggingId"
        @drag-start="emit('dragStart', $event)"
        @drag-end="emit('dragEnd')"
        @reorder="(id, targetId, position) => emit('reorder', id, targetId, position)"
      />
    </li>
  </ul>
</template>
