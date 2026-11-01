import { flattenPlaylist } from '@bplaylist/shared';
import type { PlaybackState, Playlist } from '@bplaylist/shared';
import { useQuery } from '@pinia/colada';
import { useIntervalFn } from '@vueuse/core';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { toast } from 'vue-sonner';

import { rpc } from '../rpc.ts';

export const useWorkspace = defineStore('workspace', () => {
  const state = ref<PlaybackState | null>(null);
  const busy = ref(false);
  const immersive = ref(false);
  const maximized = ref(false);
  const library = useQuery({ key: ['playlists'], query: () => rpc.list() });
  let polling = false;

  async function readState() {
    const next = await rpc.state();
    state.value = next;
    immersive.value = next.immersive;
    maximized.value = next.maximized;
  }

  watch(
    () => state.value?.error,
    error => {
      if (error) {
        toast.error(error, { id: 'playback-error' });
      }
    },
  );

  async function refresh() {
    if (polling || busy.value) {
      return;
    }

    polling = true;

    try {
      await readState();
    } catch (error) {
      if (!state.value) {
        toast.error(error instanceof Error ? error.message : '连接主进程失败');
      }
    } finally {
      polling = false;
    }
  }

  useIntervalFn(refresh, 750, { immediateCallback: true });

  async function perform(operation: () => Promise<unknown>, success?: string) {
    if (busy.value) {
      return false;
    }

    busy.value = true;

    try {
      await operation();
      await readState();
      await library.refetch();

      if (success) {
        toast.success(success);
      }

      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      busy.value = false;
    }
  }

  function edit(change: (playlist: Playlist) => void) {
    return perform(async () => {
      if (!state.value) {
        return;
      }

      const document = JSON.parse(JSON.stringify(state.value.playlist)) as Playlist;
      change(document);
      await rpc.edit(document);
    });
  }

  const queue = computed(() => flattenPlaylist(state.value?.playlist.nodes ?? []));

  const completed = computed(
    () => queue.value.filter(item => state.value?.playlist.progress[item.id]?.completed).length,
  );

  const currentIndex = computed(() =>
    queue.value.findIndex(item => item.id === state.value?.playlist.activeItemId),
  );

  const current = computed(() => queue.value[currentIndex.value]);
  return {
    state,
    immersive,
    maximized,
    busy,
    library: library.data,
    queue,
    completed,
    currentIndex,
    current,
    perform,
    edit,
  };
});
