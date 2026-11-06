import { remoteConfigSchema } from '@bplaylist/shared';
import type { Playlist } from '@bplaylist/shared';
import { syncPreferencesSchema } from '@bplaylist/shared/sync';
import type { SyncPreferences } from '@bplaylist/shared/sync';
import { SyncClient, SyncScheduler } from '@bplaylist/shared/sync-client';
import {
  Http,
  action,
  alert,
  prompt,
  inputType,
  Application,
  Connectivity,
} from '@nativescript/core';

import { call, nativeHost } from './host.ts';

type CloudConfig = { endpoint: string; token: string; scope: string } & SyncPreferences;

export function createCloud(refresh: () => void) {
  let config: CloudConfig | undefined;
  let client: SyncClient | undefined;
  let scheduler: SyncScheduler | undefined;
  let previous = '';
  let applying = false;
  let started = false;

  function connect() {
    scheduler?.stop();
    client?.stop();

    if (!config) {
      return;
    }

    const { endpoint, token, scope } = config;
    const key = `sync:v2:${scope}`;
    client = new SyncClient(
      {
        list: () => call<Playlist[]>('syncDocuments'),
        load: () => JSON.parse(call<string | null>('syncCheckpoint', key) ?? 'null'),
        commit: (checkpoint, updates) => {
          applying = true;

          try {
            call('syncCommit', { key, checkpoint, updates });
            previous = structure();
            refresh();
          } finally {
            applying = false;
          }
        },
      },
      async (path, mutation) => {
        const response = await Http.request({
          url: `${endpoint}${path}`,
          method: mutation ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(mutation ? { content: JSON.stringify(mutation) } : {}),
          timeout: 20000,
        });

        if (response.statusCode >= 400) {
          throw new Error(`同步失败（HTTP ${response.statusCode}）`);
        }

        return response.content!.toJSON();
      },
      () => java.util.UUID.randomUUID().toString(),
    );
    scheduler = new SyncScheduler(client, () => config!);
    scheduler.start();
  }

  function structure() {
    return JSON.stringify(
      call<Playlist[]>('syncDocuments').map(playlist => [
        playlist.id,
        playlist.title,
        playlist.nodes,
      ]),
    );
  }

  function observe() {
    if (!config || applying) {
      return;
    }

    const next = structure();

    if (previous && previous !== next) {
      scheduler?.changed();
    }

    previous = next;
  }

  function resume() {
    scheduler?.start(false);
    scheduler?.wake();
  }

  function suspend() {
    scheduler?.stop();
  }

  function savePreferences(preferences: SyncPreferences) {
    if (!config) {
      return;
    }

    config = { ...config, ...preferences };
    nativeHost().saveCloudConfig(JSON.stringify(config));
    scheduler?.stop();
    scheduler?.start(false);
  }

  async function configure() {
    const endpoint = await prompt({
      title: 'Worker HTTPS 地址',
      defaultText: config?.endpoint ?? '',
      okButtonText: '下一步',
      cancelButtonText: '取消',
    });

    if (!endpoint.result) {
      return;
    }

    const secret = await prompt({
      title: '访问令牌',
      inputType: inputType.password,
      okButtonText: '连接',
      cancelButtonText: '取消',
    });

    if (!secret.result) {
      return;
    }

    const parsed = remoteConfigSchema.parse({ endpoint: endpoint.text.trim(), token: secret.text });
    const root = parsed.endpoint.replace(/\/$/, '');
    const same = config?.endpoint === root && config.token === parsed.token;
    config = {
      ...syncPreferencesSchema.parse(config ?? {}),
      ...parsed,
      endpoint: root,
      scope: same ? config!.scope : java.util.UUID.randomUUID().toString(),
    };
    nativeHost().saveCloudConfig(JSON.stringify(config));
    previous = structure();
    connect();
  }

  function statusMessage() {
    if (!config) {
      return '尚未连接云端';
    }

    const status = client?.status;

    if (status?.phase === 'syncing') {
      return '同步中';
    }

    if (status?.error) {
      return `同步失败：${status.error}`;
    }

    if (status?.lastSyncedAt) {
      return `已同步\n上次成功：${new Date(status.lastSyncedAt).toLocaleString()}`;
    }

    return '等待首次同步';
  }

  async function settings() {
    try {
      const choice = await action({
        title: '云端同步',
        message: statusMessage(),
        actions: config
          ? [
              '立即同步',
              `${config.automatic ? '关闭' : '开启'}自动同步`,
              `同步间隔：${config.intervalMinutes} 分钟`,
              '修改连接',
            ]
          : ['连接云端'],
        cancelButtonText: '取消',
      });

      if (choice === '立即同步') {
        await scheduler!.now();
        refresh();
        await alert('所有播放列表与进度已同步');
      } else if (choice === '开启自动同步' || choice === '关闭自动同步') {
        savePreferences({
          automatic: !config!.automatic,
          intervalMinutes: config!.intervalMinutes,
        });
      } else if (choice.startsWith('同步间隔：')) {
        const interval = await action({
          title: '同步间隔',
          actions: ['5 分钟', '15 分钟', '30 分钟'],
          cancelButtonText: '取消',
        });

        if (interval !== '取消') {
          savePreferences(
            syncPreferencesSchema.parse({
              automatic: config!.automatic,
              intervalMinutes: Number.parseInt(interval),
            }),
          );
        }
      } else if (choice === '连接云端' || choice === '修改连接') {
        await configure();
      }
    } catch (cause) {
      await alert(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return {
    settings,
    observe,
    start() {
      if (started) {
        return;
      }

      started = true;
      const stored = nativeHost().cloudConfig();

      if (stored) {
        const value = JSON.parse(stored) as CloudConfig;
        config = {
          ...remoteConfigSchema.parse(value),
          ...syncPreferencesSchema.parse(value),
          scope: value.scope,
        };
      }

      previous = structure();
      connect();
      Application.on(Application.resumeEvent, resume);
      Application.on(Application.suspendEvent, suspend);
      Connectivity.startMonitoring(type => {
        if (type !== Connectivity.connectionType.none) {
          scheduler?.wake();
        }
      });
    },
    stop() {
      scheduler?.stop();
      client?.stop();
      Application.off(Application.resumeEvent, resume);
      Application.off(Application.suspendEvent, suspend);
      Connectivity.stopMonitoring();
      started = false;
    },
  };
}
