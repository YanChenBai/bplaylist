import { archiveSchema, remoteConfigSchema } from '@bplaylist/shared';
import type { Playlist } from '@bplaylist/shared';
import { safeStorage } from 'electron';
import { z } from 'zod';

import type { Library } from './storage/database.ts';

const remoteListSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    revision: z.number().int(),
    updatedAt: z.string(),
  }),
);

const remoteDocumentSchema = z.object({ archive: archiveSchema, revision: z.number().int() });

export class RemoteLibrary {
  constructor(private library: Library) {}

  settings() {
    return {
      endpoint: this.library.getSetting('remoteEndpoint') ?? '',
      configured: Boolean(this.library.getSetting('remoteToken')),
    };
  }

  configure(input: z.infer<typeof remoteConfigSchema>) {
    const config = remoteConfigSchema.parse(input);

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法保存同步令牌');
    }

    this.library.setSetting('remoteEndpoint', config.endpoint.replace(/\/$/, ''));
    this.library.setSetting(
      'remoteToken',
      safeStorage.encryptString(config.token).toString('base64'),
    );
    return this.settings();
  }

  private async request(path: string, init?: RequestInit) {
    const endpoint = this.library.getSetting('remoteEndpoint');
    const encrypted = this.library.getSetting('remoteToken');

    if (!endpoint || !encrypted) {
      throw new Error('请先设置 Worker 地址和访问令牌');
    }

    const token = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));

    const response = await fetch(`${endpoint}${path}`, {
      ...init,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(20000),
    });

    if (response.status === 409) {
      throw new Error('云端列表已有更新，请先下载云端版本；本地修改仍已保存，可先导出备份');
    }

    if (!response.ok) {
      throw new Error(`远程操作失败（HTTP ${response.status}）`);
    }

    return response.json() as Promise<unknown>;
  }

  async list() {
    return remoteListSchema.parse(await this.request('/playlists'));
  }

  private revisionKey(id: string) {
    return `revision:${this.library.getSetting('remoteEndpoint')}:${id}`;
  }

  async pull(id: string): Promise<Playlist> {
    const remote = remoteDocumentSchema.parse(
      await this.request(`/playlists/${encodeURIComponent(id)}`),
    );

    if (remote.archive.playlist.id !== id) {
      throw new Error('云端返回了不匹配的播放列表');
    }

    this.library.setSetting(this.revisionKey(id), String(remote.revision));
    return remote.archive.playlist;
  }

  async push(playlist: Playlist) {
    const revision = Number(this.library.getSetting(this.revisionKey(playlist.id)) ?? 0);

    const result = z.object({ revision: z.number().int() }).parse(
      await this.request(`/playlists/${encodeURIComponent(playlist.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          expectedRevision: revision,
          archive: { format: 'bplaylist', version: 1, playlist },
        }),
      }),
    );

    this.library.setSetting(this.revisionKey(playlist.id), String(result.revision));
    return result;
  }
}
