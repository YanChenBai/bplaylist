<script setup lang="ts">
import type { PlaylistNode } from '@bplaylist/shared';
import SharedItemEditor from '@bplaylist/ui/ItemEditor.vue';
import { computed } from 'vue';

import { rpc } from '../rpc.ts';
import { useWorkspace } from '../stores/workspace.ts';
const props = defineProps<{ node?: PlaylistNode; kind: 'video' | 'group'; parentId?: string }>();
const emit = defineEmits<{ close: [] }>();
const workspace = useWorkspace();

const groups = computed(
  () =>
    workspace.state?.playlist.nodes.filter(
      node => node.kind === 'group' && node.id !== props.node?.id,
    ) ?? [],
);

function saveNodes(nodes: PlaylistNode[]) {
  return workspace.edit(document => {
    for (const node of nodes) {
      const index = document.nodes.findIndex(item => item.id === node.id);

      if (index < 0) {
        document.nodes.push(node);
      } else {
        document.nodes[index] = node;
      }
    }
  });
}
</script>
<template>
  <SharedItemEditor
    :kind="kind"
    :node="node"
    :parent-id="parentId"
    :snapshot="workspace.state?.snapshot"
    :groups="groups"
    :busy="workspace.busy"
    :resolve-video="rpc.resolveVideo"
    :save-nodes="saveNodes"
    @close="emit('close')"
  />
</template>
