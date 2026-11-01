import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import worker from '../apps/sync/src/index.ts';
import { createPlaylist, videoUrl } from '../packages/shared/src/index.ts';

// 在真实 SQLite 上验证 Worker 的 SQL 与原子版本检查。
class LocalD1 {
  sqlite = new DatabaseSync(':memory:');

  constructor() {
    this.sqlite.exec(
      readFileSync(new URL('../apps/sync/migrations/0001_playlists.sql', import.meta.url), 'utf8'),
    );
  }

  prepare(query: string) {
    const statement = this.sqlite.prepare(query);
    let values: (string | number)[] = [];

    const prepared = {
      bind(...input: (string | number)[]) {
        values = input;
        return prepared;
      },
      async first() {
        return statement.get(...values) ?? null;
      },
      async all() {
        return { results: statement.all(...values) };
      },
      async run() {
        return { meta: { changes: Number(statement.run(...values).changes) } };
      },
    };

    return prepared;
  }
}

describe('D1 Worker 远程交换', () => {
  let db: LocalD1;
  let archive: { format: string; version: number; playlist: ReturnType<typeof createPlaylist> };

  beforeEach(() => {
    db = new LocalD1();
    const playlist = createPlaylist('云端列表');
    playlist.nodes = [
      {
        id: 'episode',
        parentId: null,
        kind: 'video',
        title: '原始标题',
        alias: '别名',
        partTitle: '第 1 集',
        url: videoUrl('https://www.bilibili.com/bangumi/play/ep6613853'),
        start: 10,
        end: 20,
      },
    ];
    playlist.activeItemId = 'episode';
    playlist.progress.episode = {
      position: 15,
      duration: 60,
      completed: false,
      updatedAt: playlist.updatedAt,
    };
    archive = { format: 'bplaylist', version: 1, playlist };
  });

  afterEach(() => db.sqlite.close());

  function request(path: string, method = 'GET', body?: unknown, token = 'test-token') {
    return worker.fetch(
      new Request(`https://sync.test${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        ...(method === 'PUT' ? { body: JSON.stringify(body) } : {}),
      }),
      { DB: db as unknown as Parameters<typeof worker.fetch>[1]['DB'], SYNC_TOKEN: 'test-token' },
    );
  }

  it('拒绝无令牌或错误令牌访问', async () => {
    expect((await request('/playlists', 'GET', undefined, 'wrong')).status).toBe(401);
    expect(db.sqlite.prepare('SELECT count(*) AS count FROM playlists').get()?.count).toBe(0);
  });

  it('上传、列出、下载完整列表与进度', async () => {
    const path = `/playlists/${archive.playlist.id}`;
    const result = await request(path, 'PUT', { expectedRevision: 0, archive });
    expect(await result.json()).toEqual({ revision: 1 });
    const list = (await (await request('/playlists')).json()) as { title: string }[];
    expect(list[0]?.title).toBe('云端列表');
    const download = await (await request(path)).json();
    expect(download).toEqual({ archive, revision: 1 });
  });

  it('两台设备上传同一版本只允许一次成功', async () => {
    const path = `/playlists/${archive.playlist.id}`;
    await request(path, 'PUT', { expectedRevision: 0, archive });

    const results = await Promise.all([
      request(path, 'PUT', { expectedRevision: 1, archive }),
      request(path, 'PUT', { expectedRevision: 1, archive }),
    ]);

    expect(results.map(response => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect((await request(path, 'PUT', { expectedRevision: 0, archive })).status).toBe(409);
  });

  it('拒绝不匹配 ID 和不合法的片段', async () => {
    expect(
      (await request('/playlists/other', 'PUT', { expectedRevision: 0, archive })).status,
    ).toBe(400);
    const node = archive.playlist.nodes[0]!;

    if (node.kind === 'video') {
      node.end = 1;
    }

    expect(
      (await request(`/playlists/${archive.playlist.id}`, 'PUT', { expectedRevision: 0, archive }))
        .status,
    ).toBe(400);
  });
});
