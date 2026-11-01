import type { BridgeService } from '@bplaylist/bridge';
import type { PlaylistNode } from '@bplaylist/shared';
import { playlistSchema } from '@bplaylist/shared';

import type { PlaybackController } from '../player/controller.ts';
import type { Library } from '../storage/database.ts';

export function createBrowserService(library: Library, player: PlaybackController): BridgeService {
  const document = (id: string) => {
    const playlist = id === player.playlist.id ? structuredClone(player.playlist) : library.get(id);

    if (!playlist) {
      throw new Error('播放列表不存在，请刷新后重试');
    }

    return playlist;
  };

  return {
    list() {
      const selectedId = player.selectedPlaylist.id;
      return library
        .list()
        .map(item => ({ id: item.id, title: item.title, active: item.id === selectedId }));
    },
    groups: id =>
      document(id)
        .nodes.filter(node => node.kind === 'group')
        .map(({ id, title }) => ({ id, title })),
    async append(id: string, nodes: PlaylistNode[]) {
      const playlist = document(id);
      const existing = new Map(playlist.nodes.map(node => [node.id, node]));

      if (nodes.every(node => JSON.stringify(existing.get(node.id)) === JSON.stringify(node))) {
        return { added: 0, playlistId: id };
      }

      if (nodes.some(node => existing.has(node.id))) {
        throw new Error('条目已存在，请勿重复添加');
      }

      playlist.nodes.push(...nodes);
      playlist.updatedAt = new Date().toISOString();
      const parsed = playlistSchema.parse(playlist);

      await player.edit(parsed);

      return { added: nodes.length, playlistId: id };
    },
  };
}
