import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import worker from '../apps/sync/src/index.ts';
import { createPlaylist, videoUrl } from '../packages/shared/src/index.ts';
import type { Playlist } from '../packages/shared/src/index.ts';
import { SyncClient, SyncScheduler } from '../packages/shared/src/sync-client.ts';
import type { SyncCheckpoint } from '../packages/shared/src/sync-client.ts';
import { applyPlaylistPatch, playlistPatch } from '../packages/shared/src/sync.ts';
import type { SyncPreferences } from '../packages/shared/src/sync.ts';

// 在真实 SQLite 上验证 Worker 的 SQL 与原子版本检查。
class LocalD1 {
  sqlite = new DatabaseSync(':memory:');

  constructor() {
    this.sqlite.exec(
      readFileSync(new URL('../apps/sync/migrations/0001_playlists.sql', import.meta.url), 'utf8'),
    );
    this.sqlite.exec(
      readFileSync(new URL('../apps/sync/migrations/0002_auto_sync.sql', import.meta.url), 'utf8'),
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
      first() {
        return statement.get(...values) ?? null;
      },
      all() {
        return { results: statement.all(...values) };
      },
      run() {
        return { meta: { changes: Number(statement.run(...values).changes) } };
      },
    };

    return prepared;
  }

  batch(statements: ReturnType<LocalD1['prepare']>[]) {
    this.sqlite.exec('BEGIN');

    try {
      const result = statements.map(statement => statement.run());
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
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

describe('增量自动同步', () => {
  let db: LocalD1;

  beforeEach(() => {
    db = new LocalD1();
  });
  afterEach(() => {
    db.sqlite.close();
    vi.useRealTimers();
  });

  async function request(path: string, mutation?: unknown) {
    const response = await worker.fetch(
      new Request(`https://sync.test${path}`, {
        method: mutation ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer test-token' },
        ...(mutation ? { body: JSON.stringify(mutation) } : {}),
      }),
      { DB: db as unknown as Parameters<typeof worker.fetch>[1]['DB'], SYNC_TOKEN: 'test-token' },
    );

    if (!response.ok) {
      throw new Error(`${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  function device(initial: Playlist[] = [], transport = request) {
    const documents = new Map(initial.map(item => [item.id, structuredClone(item)]));
    let checkpoint: SyncCheckpoint | undefined;

    const storage = {
      list: () => [...documents.values()].map(item => structuredClone(item)),
      load: () => (checkpoint ? structuredClone(checkpoint) : null),
      commit(next: SyncCheckpoint, updates: { id: string; playlist: Playlist | null }[]) {
        for (const update of updates) {
          if (update.playlist) {
            documents.set(update.id, structuredClone(update.playlist));
          } else {
            documents.delete(update.id);
          }
        }

        checkpoint = structuredClone(next);
      },
    };

    return {
      documents,
      storage,
      client: new SyncClient(storage, transport, () => crypto.randomUUID()),
    };
  }

  function fixture() {
    const playlist = createPlaylist('教程');
    playlist.nodes = [
      { id: 'group', kind: 'group', title: '第一章', parentId: null },
      {
        id: 'video',
        kind: 'video',
        title: '视频',
        alias: '',
        partTitle: 'P1',
        parentId: 'group',
        url: videoUrl('BV1XSMpzdEWD'),
        start: 0,
        end: null,
      },
    ];
    return playlist;
  }

  it('合并两台离线设备对同一条目不同字段和不同节点的修改', async () => {
    const playlist = fixture();
    const a = device([playlist]);
    const b = device();
    await a.client.sync();
    await b.client.sync();
    const left = a.documents.get(playlist.id)!;
    const right = b.documents.get(playlist.id)!;
    left.nodes[1]!.title = '新标题';
    right.nodes[1] = { ...right.nodes[1]!, alias: '我的别名' } as Playlist['nodes'][number];
    right.nodes.push({ id: 'other', kind: 'group', parentId: null, title: '新增分组' });
    await Promise.all([a.client.sync(), b.client.sync()]);
    await a.client.sync();
    await b.client.sync();
    expect(a.documents.get(playlist.id)).toEqual(b.documents.get(playlist.id));
    expect(a.documents.get(playlist.id)?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'video', title: '新标题', alias: '我的别名' }),
        expect.objectContaining({ id: 'other' }),
      ]),
    );
    expect(((await request('/sync?cursor=9999')) as { documents: unknown[] }).documents).toEqual(
      [],
    );
  });

  it('删除分组和整个列表后旧设备的修改不能将它们复活', async () => {
    const playlist = fixture();
    const a = device([playlist]);
    const b = device();
    await a.client.sync();
    await b.client.sync();
    a.documents.get(playlist.id)!.nodes = [];
    await a.client.sync();
    b.documents.get(playlist.id)!.nodes[1]!.title = '离线改名';
    await b.client.sync();
    expect(b.documents.get(playlist.id)!.nodes).toEqual([]);
    a.documents.delete(playlist.id);
    await a.client.sync();
    b.documents.get(playlist.id)!.title = '旧设备改名';
    await b.client.sync();
    expect(b.documents.has(playlist.id)).toBe(false);
  });

  it('响应丢失并重启后重放原操作，不重复增加版本，不覆盖后续编辑', async () => {
    const playlist = fixture();
    let loseResponse = true;

    const a = device([playlist], async (path, mutation) => {
      const response = await request(path, mutation);

      if (mutation && loseResponse) {
        loseResponse = false;
        throw new TypeError('connection lost');
      }

      return response;
    });

    await expect(a.client.sync()).rejects.toThrow('connection lost');
    a.documents.get(playlist.id)!.title = '请求后继续编辑';
    const restarted = new SyncClient(a.storage, request, () => crypto.randomUUID());
    await restarted.sync();
    expect(a.documents.get(playlist.id)!.title).toBe('请求后继续编辑');
    expect(
      db.sqlite.prepare('SELECT revision FROM playlists WHERE id=?').get(playlist.id)?.revision,
    ).toBe(1);
    await restarted.sync();
    expect(
      db.sqlite.prepare('SELECT revision FROM playlists WHERE id=?').get(playlist.id)?.revision,
    ).toBe(2);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM sync_changes').get()?.count).toBe(2);
  });

  it('同步请求途中继续编辑，响应合并后仍保留修改', async () => {
    const playlist = fixture();
    let edit: (() => void) | undefined;

    const a = device([playlist], async (path, mutation) => {
      const result = await request(path, mutation);
      edit?.();
      edit = undefined;
      return result;
    });

    edit = () => {
      a.documents.get(playlist.id)!.nodes[1]!.title = '同步期间编辑';
    };

    await a.client.sync();
    expect(a.documents.get(playlist.id)!.nodes[1]!.title).toBe('同步期间编辑');
    await a.client.sync();
    const b = device();
    await b.client.sync();
    expect(b.documents.get(playlist.id)!.nodes[1]!.title).toBe('同步期间编辑');
  });

  it('分页导入全部列表，之后空轮询不重复读取文档', async () => {
    for (let index = 0; index < 103; index++) {
      const playlist = createPlaylist(`列表 ${index}`);
      db.sqlite
        .prepare('INSERT INTO playlists (id,title,document,revision,updated_at) VALUES (?,?,?,?,?)')
        .run(
          playlist.id,
          playlist.title,
          JSON.stringify({ format: 'bplaylist', version: 1, playlist }),
          1,
          playlist.updatedAt,
        );
      db.sqlite
        .prepare('INSERT INTO sync_changes (playlist_id,mutation_id) VALUES (?,?)')
        .run(playlist.id, `seed-${index}`);
    }

    const transport = vi.fn(request);
    const a = device([], transport);
    await a.client.sync();
    expect(a.documents.size).toBe(103);
    expect(transport).toHaveBeenCalledTimes(2);
    transport.mockClear();
    await a.client.sync();
    expect(transport).toHaveBeenCalledExactlyOnceWith('/sync?cursor=103');
  });

  it('并发修改时间范围作为整体合并，不产生结束时间早于开始时间的片段', async () => {
    const playlist = fixture();
    Object.assign(playlist.nodes[1]!, { start: 10, end: 100 });
    const a = device([playlist]);
    const b = device();
    await a.client.sync();
    await b.client.sync();
    Object.assign(a.documents.get(playlist.id)!.nodes[1]!, { start: 80 });
    Object.assign(b.documents.get(playlist.id)!.nodes[1]!, { end: 50 });
    await a.client.sync();
    await b.client.sync();
    await a.client.sync();
    expect(a.documents.get(playlist.id)!.nodes[1]).toMatchObject({ start: 10, end: 50 });
  });

  it('允许新播放会话回看，旧会话的后续上报不能抢回进度', () => {
    const playlist = fixture();
    playlist.progress.video = {
      sessionStartedAt: '2026-11-06T10:00:00.000Z',
      updatedAt: '2026-11-06T10:10:00.000Z',
      position: 500,
      duration: 600,
      completed: false,
    };
    const document = { id: playlist.id, playlist, tombstones: [], revision: 1 };
    const local = structuredClone(playlist);
    local.progress.video = {
      sessionStartedAt: '2026-11-06T10:05:00.000Z',
      updatedAt: '2026-11-06T10:06:00.000Z',
      position: 20,
      duration: 600,
      completed: false,
    };
    const merged = applyPlaylistPatch(document, playlistPatch(playlist, local), local.updatedAt);
    expect(merged.playlist!.progress.video!.position).toBe(20);
    const older = structuredClone(playlist);
    older.progress.video!.updatedAt = '2026-11-06T10:20:00.000Z';
    older.progress.video!.position = 550;
    expect(
      applyPlaylistPatch(merged, playlistPatch(playlist, older), older.updatedAt).playlist!.progress
        .video!.position,
    ).toBe(20);
  });

  it('卸载旧配置后迟到的响应不能写入新配置或本地列表', async () => {
    const playlist = fixture();

    const a = device([playlist], async (path, mutation) => {
      const result = await request(path, mutation);
      a.client.stop();
      return result;
    });

    await expect(a.client.sync()).rejects.toThrow('同步配置已更改');
    expect(a.storage.load()?.pending).toHaveLength(1);
  });

  it('默认五分钟轮询，编辑一分钟合并，手动同步绕过冷却，关闭自动后不发请求', async () => {
    vi.useFakeTimers();
    let preferences: SyncPreferences = { automatic: true, intervalMinutes: 5 };

    const client = new SyncClient(
      { list: () => [], load: () => null, commit: () => {} },
      async () => ({ cursor: 0, hasMore: false, documents: [] }),
      () => crypto.randomUUID(),
    );

    const sync = vi.spyOn(client, 'sync');
    const scheduler = new SyncScheduler(client, () => preferences);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(59000);
    expect(sync).toHaveBeenCalledTimes(1);
    scheduler.changed();
    await vi.advanceTimersByTimeAsync(30000);
    scheduler.changed();
    await vi.advanceTimersByTimeAsync(59000);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(299999);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(3);
    preferences = { automatic: false, intervalMinutes: 30 };
    scheduler.stop();
    scheduler.start(false);
    scheduler.changed();
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(sync).toHaveBeenCalledTimes(3);
    await scheduler.now();
    expect(sync).toHaveBeenCalledTimes(4);
    scheduler.stop();
  });

  it('自动失败按一分钟、两分钟退避，手动仍可立即重试', async () => {
    vi.useFakeTimers();

    const client = new SyncClient(
      { list: () => [], load: () => null, commit: () => {} },
      async () => {
        throw new TypeError('offline');
      },
      () => crypto.randomUUID(),
    );

    const sync = vi.spyOn(client, 'sync');
    const scheduler = new SyncScheduler(client, () => ({ automatic: true, intervalMinutes: 5 }));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119999);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(3);
    await expect(scheduler.now()).rejects.toThrow('offline');
    expect(sync).toHaveBeenCalledTimes(4);
    scheduler.stop();
  });
});
