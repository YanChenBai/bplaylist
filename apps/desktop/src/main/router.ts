import { readFile, stat, writeFile } from 'node:fs/promises';

import {
  archiveSchema,
  createPlaylist,
  isBilibiliUrl,
  playlistSchema,
  remoteConfigSchema,
  videoUrl,
} from '@bplaylist/shared';
import { ORPCError, os } from '@orpc/server';
import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';

import type { WindowChrome } from './app/window-chrome.ts';
import type { PlaybackController } from './player/controller.ts';
import type { RemoteLibrary } from './remote.ts';
import type { Library } from './storage/database.ts';

const procedure = os.use(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ORPCError) {
      throw error;
    }

    throw new ORPCError('BAD_REQUEST', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export function createRouter(
  library: Library,
  player: PlaybackController,
  remote: RemoteLibrary,
  getWindow: () => BrowserWindow | null,
  chrome: WindowChrome,
) {
  return {
    resolveVideo: procedure
      .input(z.string().transform(value => videoUrl(value)))
      .handler(({ input }) => player.resolveVideo(input)),
    state: procedure.handler(() => ({
      ...player.state(),
      ...chrome.state(),
    })),
    immersive: procedure.input(z.boolean()).handler(({ input }) => {
      chrome.setImmersive(input);
    }),
    windowState: procedure.handler(() => chrome.state()),
    windowControl: procedure
      .input(z.enum(['minimize', 'maximize', 'close']))
      .handler(({ input }) => chrome.control(input)),
    list: procedure.handler(() => library.list().map(({ id, title }) => ({ id, title }))),
    create: procedure.input(z.string().trim().min(1).max(200)).handler(async ({ input }) => {
      await player.replace(createPlaylist(input));
      return player.state();
    }),
    select: procedure.input(z.string()).handler(async ({ input }) => {
      await player.select(input);
      return player.state();
    }),
    edit: procedure.input(playlistSchema).handler(({ input }) => player.edit(input)),
    play: procedure
      .input(z.object({ id: z.string(), resume: z.boolean().default(true) }))
      .handler(async ({ input }) => {
        await player.play(input.id, input.resume);
        return player.state();
      }),
    step: procedure.input(z.union([z.literal(-1), z.literal(1)])).handler(async ({ input }) => {
      await player.step(input);
      return player.state();
    }),
    control: procedure
      .input(
        z.object({
          action: z.enum(['play', 'pause', 'seek', 'fullscreen']),
          position: z.number().finite().nonnegative().optional(),
        }),
      )
      .handler(async ({ input }) => {
        await player.control(input);
        return player.state();
      }),
    fullscreen: procedure.input(z.boolean()).handler(({ input }) => player.setFullscreen(input)),
    navigate: procedure.input(z.string().refine(isBilibiliUrl)).handler(async ({ input }) => {
      await player.stop();
      await player.navigate(input);
    }),
    importFile: procedure.handler(async () => {
      const window = getWindow();

      if (!window) {
        throw new Error('窗口已关闭');
      }

      const result = await dialog.showOpenDialog(window, {
        title: '导入播放列表',
        properties: ['openFile'],
        filters: [{ name: 'BPlaylist JSON', extensions: ['json'] }],
      });

      const path = result.filePaths[0];

      if (result.canceled || !path) {
        return null;
      }

      if ((await stat(path)).size > 5 * 1024 * 1024) {
        throw new Error('导入文件不能超过 5 MB');
      }

      const archive = archiveSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      archive.playlist.id = crypto.randomUUID();
      await player.replace(archive.playlist);
      return player.state();
    }),
    exportFile: procedure.handler(async () => {
      const window = getWindow();

      if (!window) {
        throw new Error('窗口已关闭');
      }

      const result = await dialog.showSaveDialog(window, {
        title: '导出播放列表（包含进度）',
        defaultPath: `${player.playlist.title.replace(/[<>:"/\\|?*]/g, '_')}.json`,
        filters: [{ name: 'BPlaylist JSON', extensions: ['json'] }],
      });

      if (result.canceled || !result.filePath) {
        return false;
      }

      player.persist();
      await writeFile(
        result.filePath,
        JSON.stringify({ format: 'bplaylist', version: 1, playlist: player.playlist }, null, 2),
        'utf8',
      );
      return true;
    }),
    remote: {
      settings: procedure.handler(() => remote.settings()),
      configure: procedure
        .input(remoteConfigSchema)
        .handler(({ input }) => remote.configure(input)),
      list: procedure.handler(() => remote.list()),
      push: procedure.handler(() => {
        player.persist();
        return remote.push(player.playlist);
      }),
      pull: procedure.input(z.string().min(1).max(100)).handler(async ({ input }) => {
        const document = await remote.pull(input);
        await player.replace(document);
        return player.state();
      }),
    },
  };
}

export type AppRouter = ReturnType<typeof createRouter>;
