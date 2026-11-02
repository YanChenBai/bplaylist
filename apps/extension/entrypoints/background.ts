import type { BridgeClient } from '@bplaylist/bridge';
import { emptySnapshot, isBilibiliUrl, snapshotSchema, videoUrl } from '@bplaylist/shared';
import { resolveVideoMetadata, videoMetadataSchema } from '@bplaylist/shared/bilibili';
import { bridgeConnectionSchema } from '@bplaylist/shared/bridge';
import type { BridgeConnection } from '@bplaylist/shared/bridge';
import { createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { browser } from 'wxt/browser';

import { messageSchema } from '../lib/messages.ts';

function client(connection: BridgeConnection) {
  return createORPCClient<BridgeClient>(
    new RPCLink({
      url: `${connection.endpoint.replace(/\/$/, '')}/rpc`,
      headers: { authorization: `Bearer ${connection.token}` },
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }),
    }),
  );
}

async function handleMessage(
  raw: unknown,
  sender: Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1],
) {
  const message = messageSchema.parse(raw);

  if (message.action === 'connect') {
    if (!sender.url?.startsWith(browser.runtime.getURL('/'))) {
      throw new Error('请在插件设置中连接');
    }

    const list = await client(message.connection).list();
    await browser.storage.local.set({ connection: message.connection });
    return list;
  }

  if (message.action === 'capture' || message.action === 'resolve') {
    return readPage(
      requireBilibiliTab(sender),
      message.action === 'resolve' ? message.url : undefined,
    );
  }

  const stored = await browser.storage.local.get('connection');
  const connection = bridgeConnectionSchema.safeParse(stored.connection);

  if (!connection.success) {
    throw new Error('尚未连接 BPlaylist，请点击浏览器工具栏图标配置连接');
  }

  const api = client(connection.data);

  switch (message.action) {
    case 'list': {
      return api.list();
    }

    case 'groups': {
      return api.groups(message.playlistId);
    }

    case 'append': {
      return api.append(message.input);
    }
  }
}

function requireBilibiliTab(
  sender: Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1],
) {
  if (sender.tab?.id === undefined || !sender.url || !isBilibiliUrl(sender.url)) {
    throw new Error('请在 B 站视频页面使用');
  }

  return sender.tab.id;
}

async function readPage(tabId: number, input?: string) {
  const snapshots = await browser.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const video = document.querySelector('video');
      return {
        url: location.href,
        available: Boolean(video),
        position: video?.currentTime ?? 0,
        duration: Number.isFinite(video?.duration) ? video!.duration : 0,
        paused: video?.paused ?? true,
        ended: video?.ended ?? false,
      };
    },
  });

  const snapshot = snapshotSchema.parse({ ...emptySnapshot, ...snapshots[0]?.result });

  const results = await browser.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: resolveVideoMetadata,
    args: [videoUrl(input ?? snapshot.url)],
  });

  const parsed = videoMetadataSchema.safeParse(results[0]?.result);

  if (!parsed.success) {
    throw new Error('无法读取视频或分集信息，请确认当前页面可以正常播放后重试');
  }

  return input ? parsed.data : snapshotSchema.parse({ ...snapshot, ...parsed.data });
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(async (raw: unknown, sender) => {
    try {
      if (sender.id !== browser.runtime.id) {
        throw new Error('不允许的请求来源');
      }

      return { ok: true, data: await handleMessage(raw, sender) };
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);

      if (error instanceof ORPCError && error.status === 401) {
        message = '连接密钥已失效，请从 BPlaylist 重新复制连接信息';
      }

      if (/fetch|network|abort|timeout/i.test(message)) {
        message = '无法连接设备，请确认 BPlaylist 已启动，并检查网络和连接信息';
      }

      return { ok: false, error: message };
    }
  });
});
