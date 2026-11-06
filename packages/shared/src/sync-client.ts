import { z } from 'zod';

import { playlistSchema } from './index.ts';
import type { Playlist } from './index.ts';
import {
  applyPlaylistPatch,
  hasPlaylistPatch,
  playlistPatch,
  syncDocumentSchema,
  syncMutationSchema,
  syncPageSchema,
  syncPreferencesSchema,
} from './sync.ts';
import type { SyncDocument, SyncPreferences } from './sync.ts';

const checkpointSchema = z.object({
  cursor: z.number().int().nonnegative().default(0),
  documents: z.record(z.string(), syncDocumentSchema).default({}),
  pending: z
    .array(z.object({ mutation: syncMutationSchema, local: playlistSchema.nullable() }))
    .default([]),
  lastSyncedAt: z.string().nullable().default(null),
});

export type SyncCheckpoint = z.infer<typeof checkpointSchema>;

export interface SyncStorage {
  list(): Playlist[];
  load(): unknown;
  // 本地文档和确认游标必须在同一事务中落盘。
  commit(checkpoint: SyncCheckpoint, updates: { id: string; playlist: Playlist | null }[]): void;
}

export interface SyncStatus {
  phase: 'unconfigured' | 'idle' | 'syncing' | 'offline' | 'error';
  lastSyncedAt: string | null;
  error: string | null;
}

export class SyncClient {
  status: SyncStatus;
  private checkpoint: SyncCheckpoint;
  private pending?: Promise<void>;
  private stopped = false;

  constructor(
    private storage: SyncStorage,
    private request: (path: string, mutation?: unknown) => Promise<unknown>,
    private uuid: () => string,
  ) {
    this.checkpoint = checkpointSchema.parse(storage.load() ?? {});
    this.status = { phase: 'idle', lastSyncedAt: this.checkpoint.lastSyncedAt, error: null };
  }

  stop() {
    this.stopped = true;
  }

  sync(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }

    if (!this.pending) {
      this.pending = this.exchange().finally(() => {
        this.pending = undefined;
      });
    }

    return this.pending;
  }

  private save(updates: { id: string; playlist: Playlist | null }[] = []) {
    if (this.stopped) {
      throw new Error('同步配置已更改');
    }

    this.storage.commit(this.checkpoint, updates);
  }

  private accept(document: SyncDocument, base: Playlist | null) {
    if (this.stopped) {
      throw new Error('同步配置已更改');
    }

    const current = this.storage.list().find(item => item.id === document.id) ?? null;
    const local = playlistPatch(base, current);

    const merged = hasPlaylistPatch(local)
      ? applyPlaylistPatch(document, local, current?.updatedAt ?? new Date().toISOString())
      : document;

    this.checkpoint.documents[document.id] = document;
    return { id: document.id, playlist: merged.playlist };
  }

  private async exchange() {
    this.status = { ...this.status, phase: 'syncing', error: null };

    try {
      // 请求前持久化原始补丁及其 ID；响应丢失或应用重启都重放同一个操作。
      if (!this.checkpoint.pending.length) {
        const documents = new Map(this.storage.list().map(item => [item.id, item]));

        for (const id of new Set([
          ...documents.keys(),
          ...Object.keys(this.checkpoint.documents),
        ])) {
          const local = documents.get(id) ?? null;
          const base = this.checkpoint.documents[id];

          if (!local && (!base || !base.playlist)) {
            continue;
          }

          const patch = playlistPatch(base?.playlist ?? null, local);

          if (hasPlaylistPatch(patch)) {
            this.checkpoint.pending.push({
              mutation: { id, mutationId: this.uuid(), patch },
              local: local ? JSON.parse(JSON.stringify(local)) : null,
            });
          }
        }

        this.save();
      }

      while (this.checkpoint.pending.length) {
        const pending = this.checkpoint.pending[0]!;
        const document = syncDocumentSchema.parse(await this.request('/sync', pending.mutation));

        if (document.id !== pending.mutation.id) {
          throw new Error('云端返回了不匹配的播放列表');
        }

        const update = this.accept(document, pending.local);
        this.checkpoint.pending.shift();
        this.save([update]);
      }

      let hasMore = true;

      while (hasMore) {
        const page = syncPageSchema.parse(
          await this.request(`/sync?cursor=${this.checkpoint.cursor}`),
        );

        if (
          page.cursor < this.checkpoint.cursor ||
          (page.hasMore && page.cursor === this.checkpoint.cursor)
        ) {
          throw new Error('云端同步游标无效');
        }

        const updates = page.documents.flatMap(document => {
          const base = this.checkpoint.documents[document.id];

          if (base && base.revision >= document.revision) {
            return [];
          }

          // 新的云端列表没有本地副本时应导入，而不是误认为被本地删除。
          if (base) {
            return [this.accept(document, base.playlist)];
          }

          this.checkpoint.documents[document.id] = document;
          return [{ id: document.id, playlist: document.playlist }];
        });

        this.checkpoint.cursor = page.cursor;
        this.save(updates);
        hasMore = page.hasMore;
      }

      this.checkpoint.lastSyncedAt = new Date().toISOString();
      this.save();
      this.status = { phase: 'idle', lastSyncedAt: this.checkpoint.lastSyncedAt, error: null };
    } catch (error) {
      this.checkpoint = checkpointSchema.parse(this.storage.load() ?? {});
      const message = error instanceof Error ? error.message : String(error);
      this.status = {
        ...this.status,
        phase: error instanceof TypeError ? 'offline' : 'error',
        error: message,
      };
      throw error;
    }
  }
}

export class SyncScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private lastAttempt = 0;
  private retryAfter = 0;
  private failures = 0;
  private dirtyAt = 0;
  private active = true;

  constructor(
    private client: SyncClient,
    private preferences: () => SyncPreferences,
  ) {}

  start(immediate = true) {
    this.active = true;
    this.schedule(immediate ? 0 : this.preferences().intervalMinutes * 60000);
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
  }

  changed() {
    this.dirtyAt = Date.now();
    this.schedule(60000);
  }

  wake() {
    const cooldown = 5 * 60000;

    if (Date.now() - this.lastAttempt >= cooldown) {
      this.schedule(0);
    }
  }

  async now() {
    const dirtyAt = this.dirtyAt;
    this.lastAttempt = Date.now();

    try {
      await this.client.sync();
      this.failures = 0;
      this.retryAfter = 0;

      if (this.dirtyAt === dirtyAt) {
        this.dirtyAt = 0;
      }
    } catch (error) {
      this.failures++;
      this.retryAfter = Date.now() + Math.min(30, 2 ** (this.failures - 1)) * 60000;
      throw error;
    } finally {
      let delay = this.preferences().intervalMinutes * 60000;

      if (this.failures) {
        delay = Math.max(0, this.retryAfter - Date.now());
      } else if (this.dirtyAt) {
        delay = Math.max(0, this.dirtyAt + 60000 - Date.now());
      }

      this.schedule(delay);
    }
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    const preferences = syncPreferencesSchema.parse(this.preferences());

    if (!this.active || !preferences.automatic) {
      return;
    }

    const due = Math.max(
      Date.now() + delay,
      this.retryAfter,
      this.dirtyAt ? this.dirtyAt + 60000 : 0,
    );

    this.timer = setTimeout(
      () => {
        void this.now().catch(() => {
          // 错误已保存在同步状态中，自动同步无需弹窗打断播放。
        });
      },
      Math.max(0, due - Date.now()),
    );
  }
}
