<script setup lang="ts">
import type { PlaylistNode } from '@bplaylist/shared';
import type { EventData, View } from '@nativescript/core';
import { watch } from 'nativescript-vue';

import { animate, enter } from '../motion.ts';

const props = defineProps<{
  item: {
    node: PlaylistNode;
    depth: number;
    number: number;
    active: boolean;
    collapsed: boolean;
    title: string;
    detail: string;
  };
}>();

const emit = defineEmits<{ activate: [node: PlaylistNode]; menu: [node: PlaylistNode] }>();
let chevron: View | undefined;

function chevronLoaded(event: EventData) {
  chevron = event.object as View;
  chevron.rotate = props.item.collapsed ? 0 : 90;
}

watch(
  () => props.item.collapsed,
  collapsed => {
    void animate(chevron, { rotate: collapsed ? 0 : 90, duration: 140 });
  },
);

function loaded(event: EventData) {
  enter(event.object as View, 4);
}
</script>
<template>
  <GridLayout
    columns="auto,*,auto"
    :rows="item.node.kind === 'group' ? 'auto' : 'auto,auto'"
    class="mx-2.5 my-0.5 rounded-lg border px-2.5"
    :class="[
      item.active ? 'bg-raised border-border' : 'border-transparent',
      item.node.kind === 'group' ? 'py-2' : 'py-3',
    ]"
    :marginLeft="10 + item.depth * 12"
    @loaded="loaded"
    @tap="emit('activate', item.node)"
    @longPress="emit('menu', item.node)"
  >
    <Image
      :visibility="item.node.kind === 'group' ? 'visible' : 'collapse'"
      src="res://ic_chevron"
      @loaded="chevronLoaded"
      class="mr-2 h-3.5 w-3.5"
      verticalAlignment="center"
    />
    <Label
      :visibility="item.node.kind === 'video' ? 'visible' : 'collapse'"
      rowSpan="2"
      col="0"
      :text="String(item.number)"
      class="text-dim mr-2 w-4 text-[length:10]"
      verticalAlignment="center"
    />
    <Label
      row="0"
      col="1"
      :text="item.title"
      class="text-heading text-[length:13]"
      textWrap="false"
    />
    <Label
      :visibility="item.node.kind === 'group' ? 'visible' : 'collapse'"
      col="2"
      :text="item.detail"
      class="text-dim ml-3 text-[length:10]"
      verticalAlignment="center"
    />
    <Label
      :visibility="item.node.kind === 'video' ? 'visible' : 'collapse'"
      row="1"
      col="1"
      :text="item.detail"
      class="text-dim mt-[5] text-[length:10]"
      textWrap="false"
    />
  </GridLayout>
</template>
