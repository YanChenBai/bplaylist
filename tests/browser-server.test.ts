import { randomInt } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { BrowserServer } from '../apps/desktop/src/main/app/browser-server.ts';
import { createBrowserService } from '../apps/desktop/src/main/app/browser-service.ts';
import { PlaybackController } from '../apps/desktop/src/main/player/controller.ts';
import { openLibrary } from '../apps/desktop/src/main/storage/database.ts';
import type { BridgeClient } from '../packages/bridge/src/index.ts';
import { createPlaylist, videoUrl } from '../packages/shared/src/index.ts';
import type { PlaylistNode } from '../packages/shared/src/index.ts';

vi.mock('../apps/desktop/src/main/player/scripts/install.ts?inject', () => ({ default: 'read' }));
vi.mock('../apps/desktop/src/main/player/scripts/command.ts?inject', () => ({
  default: 'command',
}));

describe('browser HTTP bridge', () => {
  let library: ReturnType<typeof openLibrary>;
  let player: PlaybackController;
  let server: BrowserServer;
  let endpoint: string;
  let token: string;
  let client: BridgeClient;

  const video = (id: string, parentId: string | null = null): PlaylistNode => ({
    id,
    parentId,
    kind: 'video',
    alias: '',
    partTitle: 'P1',
    title: id,
    url: videoUrl('BV1GJ411x7h7'),
    start: 18,
    end: 36,
  });

  beforeEach(async () => {
    library = openLibrary(':memory:');
    player = new PlaybackController(library);

    for (let attempts = 0; attempts < 5; attempts++) {
      server = new BrowserServer(library, createBrowserService(library, player));
      ({ endpoint, token } = await server.start(randomInt(30000, 50000)));

      if (server.settings().connected) {
        break;
      }

      await server.close();
    }

    expect(server.settings().connected).toBe(true);
    client = createORPCClient<BridgeClient>(
      new RPCLink({ url: `${endpoint}/rpc`, headers: { authorization: `Bearer ${token}` } }),
    );
  });
  afterEach(async () => {
    await server.close();
    player.dispose();
    library.close();
  });

  it('lists targets and atomically appends concurrent requests without replacing progress', async () => {
    const playlist = createPlaylist('当前列表');
    playlist.nodes.push(video('playing'));
    playlist.activeItemId = 'playing';
    playlist.progress.playing = {
      position: 25,
      duration: 100,
      completed: false,
      updatedAt: new Date().toISOString(),
    };
    await player.replace(playlist);
    player.running = true;
    const stale = structuredClone(player.state());
    await Promise.all([
      client.append({ playlistId: playlist.id, nodes: [video('first')] }),
      client.append({
        playlistId: playlist.id,
        nodes: [
          { id: 'group', parentId: null, kind: 'group', title: '分组' },
          video('second', 'group'),
        ],
      }),
    ]);
    await expect(player.edit(stale.playlist, stale.revision)).rejects.toThrow(
      '播放列表刚刚发生变化',
    );
    expect(player.playlist.nodes.map(node => node.id).sort()).toEqual([
      'first',
      'group',
      'playing',
      'second',
    ]);
    expect(player.playlist.progress.playing.position).toBe(25);
    expect(player.playlist.activeItemId).toBe('playing');
    expect(player.running).toBe(true);
    expect(await client.groups(playlist.id)).toEqual([{ id: 'group', title: '分组' }]);
    expect(await client.list()).toContainEqual({
      id: playlist.id,
      title: playlist.title,
      active: true,
    });
  });

  it('adds cross-part items to an inactive list without selecting it', async () => {
    const current = player.playlist.id;
    const target = createPlaylist('归档');
    library.save(target);

    const node = {
      ...video('range'),
      continuation: [{ title: 'P2', url: videoUrl('BV1GJ411x7h7', 2) }],
    };

    await client.append({ playlistId: target.id, nodes: [node] });
    expect(library.list().find(item => item.id === target.id)?.nodes[0]).toMatchObject(node);
    expect(player.playlist.id).toBe(current);
  });

  it('rejects missing targets, invalid groups and duplicate nodes without partial writes', async () => {
    const id = player.playlist.id;
    await expect(client.append({ playlistId: 'missing', nodes: [video('x')] })).rejects.toThrow(
      '播放列表不存在',
    );
    await expect(
      client.append({ playlistId: id, nodes: [video('x', 'missing')] }),
    ).rejects.toThrow();
    expect(player.playlist.nodes).toEqual([]);
    await client.append({ playlistId: id, nodes: [video('x')] });
    await expect(
      client.append({ playlistId: id, nodes: [{ ...video('x'), title: '另一个条目' }] }),
    ).rejects.toThrow('条目已存在');
    expect(await client.append({ playlistId: id, nodes: [video('x')] })).toEqual({
      added: 0,
      playlistId: id,
    });
    expect(player.playlist.nodes).toHaveLength(1);
  });

  it('requires a token, rejects page origins and foreign hosts, and revokes old tokens', async () => {
    const url = `${endpoint}/rpc/list`;
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    expect(
      (await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${'é'.repeat(64)}` } }))
        .status,
    ).toBe(401);
    const authorization = `Bearer ${token}`;
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { authorization, origin: 'https://www.bilibili.com' },
        })
      ).status,
    ).toBe(403);

    const hostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        url,
        { method: 'POST', headers: { authorization, host: 'attacker.example' } },
        response => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );

      request.on('error', reject);
      request.end();
    });

    expect(hostStatus).toBe(403);
    expect(
      (await fetch(`${endpoint}/rpc/edit`, { method: 'POST', headers: { authorization } })).status,
    ).toBe(404);
    expect((await fetch(url, { headers: { authorization } })).status).toBe(405);
    server.resetToken();
    await expect(client.list()).rejects.toThrow();
  });

  it('limits chunked bodies as well as Content-Length', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${endpoint}/rpc/append`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        },
        response => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );

      request.on('error', reject);
      request.write(Buffer.alloc(600000, 'x'));
      request.end(Buffer.alloc(600000, 'x'));
    });

    expect(status).toBe(413);
  });
});
