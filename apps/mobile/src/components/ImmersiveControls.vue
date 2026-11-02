<script setup lang="ts">
import { AnimationCurve } from '@nativescript/core';
import type { Animation, EventData, TouchGestureEventData, View } from '@nativescript/core';
import { nextTick, onUnmounted, shallowRef } from 'nativescript-vue';

import { motionEnabled } from '../motion.ts';
import IconButton from './IconButton.vue';

const emit = defineEmits<{ exit: []; toggleSidebar: [] }>();
const visible = shallowRef(true);
let controls: View | undefined;
let animation: Animation | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;

function cancelFade() {
  if (animation?.isPlaying) {
    animation.cancel();
  }

  animation = undefined;
}

async function fade(opacity: number, duration: number) {
  cancelFade();

  if (!controls) {
    return;
  }

  animation = controls.createAnimation({
    opacity,
    duration: motionEnabled() ? duration : 0,
    curve: AnimationCurve.easeOut,
  });
  await animation.play().catch(() => {
    /* 触摸或卸载会取消淡出。 */
  });
}

function clearHideTimer() {
  clearTimeout(hideTimer);
  hideTimer = undefined;
}

function scheduleHide() {
  clearHideTimer();
  hideTimer = setTimeout(hide, 3000);
}

async function hide() {
  const current = ++revision;
  await fade(0, 140);

  if (current === revision) {
    visible.value = false;
    controls = undefined;
  }
}

async function show() {
  const current = ++revision;
  clearHideTimer();
  visible.value = true;
  await nextTick();

  if (current !== revision) {
    return;
  }

  void fade(0.8, 120);
  scheduleHide();
}

function loaded(event: EventData) {
  controls = event.object as View;
  controls.opacity = 0;
  void show();
}

function touch(event: TouchGestureEventData) {
  if (event.action === 'down') {
    ++revision;
    cancelFade();
    clearHideTimer();

    if (controls) {
      controls.opacity = 0.8;
    }
  } else if (visible.value) {
    scheduleHide();
  }
}

function toggleSidebar() {
  void show();
  emit('toggleSidebar');
}

onUnmounted(() => {
  ++revision;
  clearHideTimer();
  cancelFade();
});
</script>

<template>
  <GridLayout
    class="h-[42] w-[84]"
    :accessibilityLabel="visible ? '' : '显示沉浸模式控件'"
    @tap="show"
    @touch="touch"
  >
    <GridLayout v-if="visible" columns="auto,auto" class="bg-panel rounded-lg" @loaded="loaded">
      <IconButton
        name="expand"
        accessibilityLabel="退出沉浸模式"
        @tap="emit('exit')"
        @touch="touch"
      />
      <IconButton
        col="1"
        name="panel"
        accessibilityLabel="切换播放列表侧栏"
        @tap="toggleSidebar"
        @touch="touch"
      />
    </GridLayout>
  </GridLayout>
</template>
