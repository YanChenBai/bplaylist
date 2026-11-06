import { createHash, randomUUID } from 'node:crypto';

import { remoteConfigSchema } from '@bplaylist/shared';
import { syncPreferencesSchema } from '@bplaylist/shared/sync';
import type { SyncPreferences } from '@bplaylist/shared/sync';
import { SyncClient, SyncScheduler } from '@bplaylist/shared/sync-client';
import type { SyncStatus } from '@bplaylist/shared/sync-client';
import { safeStorage } from 'electron';
import type { z } from 'zod';

import type { PlaybackController } from './player/controller.ts';
import type { Library } from './storage/database.ts';

export class RemoteLibrary {
  private client?: SyncClient;
  private scheduler?: SyncScheduler;
  private unsubscribe: () => void;
  private applying = false;
  private generation = 0;
  private disposed = false;

  constructor(
    private library: Library,
    private player: PlaybackController,
  ) {
    this.unsubscribe = library.subscribe(() => {
      if (!this.applying) {
        this.scheduler?.changed();
      }
    });
  }

  settings() {
    return {
      endpoint: this.library.getSetting('remoteEndpoint') ?? '',
      configured: Boolean(this.library.getSetting('remoteToken')),
      ...this.preferences(),
      status:
        this.client?.status ??
        ({ phase: 'unconfigured', lastSyncedAt: null, error: null } as SyncStatus),
    };
  }

  private preferences(): SyncPreferences {
    return syncPreferencesSchema.parse(
      JSON.parse(this.library.getSetting('syncPreferences') ?? '{}'),
    );
  }

  async configure(input: z.infer<typeof remoteConfigSchema>) {
    const config = remoteConfigSchema.parse(input);
    const generation = ++this.generation;

    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('系统安全存储不可用，无法保存同步令牌');
    }

    const encrypted = await safeStorage.encryptStringAsync(config.token);

    if (this.disposed || generation !== this.generation) {
      throw new Error('同步配置已更改');
    }

    this.library.transaction(() => {
      this.library.setSetting('remoteEndpoint', config.endpoint.replace(/\/$/, ''));
      this.library.setSetting('remoteToken', encrypted.toString('base64'));
    });
    await this.start();
    return this.settings();
  }

  updatePreferences(input: SyncPreferences) {
    this.library.setSetting('syncPreferences', JSON.stringify(syncPreferencesSchema.parse(input)));
    this.scheduler?.stop();
    this.scheduler?.start(false);
    return this.settings();
  }

  async start() {
    const generation = ++this.generation;
    this.scheduler?.stop();
    this.client?.stop();

    if (this.disposed) {
      return;
    }

    const endpoint = this.library.getSetting('remoteEndpoint');
    const encrypted = this.library.getSetting('remoteToken');

    if (!endpoint || !encrypted) {
      return;
    }

    const { result: token, shouldReEncrypt } = await safeStorage.decryptStringAsync(
      Buffer.from(encrypted, 'base64'),
    );

    if (this.disposed || generation !== this.generation) {
      return;
    }

    if (shouldReEncrypt) {
      const refreshed = await safeStorage.encryptStringAsync(token);

      if (this.disposed || generation !== this.generation) {
        return;
      }

      this.library.setSetting('remoteToken', refreshed.toString('base64'));
    }

    const key = `sync:v2:${createHash('sha256').update(`${endpoint}\n${token}`).digest('hex')}`;
    this.client = new SyncClient(
      {
        list: () => this.library.list(),
        load: () => JSON.parse(this.library.getSetting(key) ?? 'null'),
        commit: (checkpoint, updates) => {
          this.applying = true;

          try {
            this.library.transaction(() => {
              for (const update of updates) {
                this.player.applySync(update.id, update.playlist);
              }

              this.library.setSetting(key, JSON.stringify(checkpoint));
            });
          } finally {
            this.applying = false;
          }
        },
      },
      async (path, mutation) => {
        const response = await fetch(`${endpoint}${path}`, {
          method: mutation ? 'POST' : 'GET',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          ...(mutation ? { body: JSON.stringify(mutation) } : {}),
          signal: AbortSignal.timeout(20000),
        });

        if (!response.ok) {
          throw new Error(`同步失败（HTTP ${response.status}）`);
        }

        return response.json();
      },
      randomUUID,
    );
    this.scheduler = new SyncScheduler(this.client, () => this.preferences());
    this.scheduler.start();
  }

  wake() {
    this.scheduler?.wake();
  }

  async sync() {
    if (!this.scheduler) {
      throw new Error('请先设置 Worker 地址和访问令牌');
    }

    this.player.persist();
    await this.scheduler.now();
    return this.settings();
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.scheduler?.stop();
    this.client?.stop();
    this.unsubscribe();
  }
}
