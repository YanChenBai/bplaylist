import {
  emptySnapshot,
  flattenPlaylist,
  isBilibiliUrl,
  playbackIdentity,
  playbackSegments,
  playlistSchema,
  snapshotSchema,
  videoPartSchema,
} from '@bplaylist/shared';
import type {
  PlaybackState,
  Playlist,
  PlaylistNode,
  PlayerSnapshot,
  VideoItem,
} from '@bplaylist/shared';
import type { WebContents } from 'electron';
import { z } from 'zod';

import type { Library } from '../storage/database.ts';
import commandScript from './scripts/command.ts?inject';
import installScript from './scripts/install.ts?inject';
import resolveScript from './scripts/resolve.ts?inject';

type Command = { action: 'play' | 'pause' | 'seek' | 'fullscreen'; position?: number };

function playbackSource(node: PlaylistNode | undefined) {
  return node?.kind === 'video' ? JSON.stringify(playbackSegments(node)) : null;
}

export class PlaybackController {
  playlist: Playlist;
  snapshot: PlayerSnapshot = { ...emptySnapshot };
  running = false;
  error: string | null = null;
  autoFullscreen: boolean;
  private guest?: WebContents;
  private timer: ReturnType<typeof setInterval>;
  private busy = false;
  private generation = 0;
  private pending?: { item: VideoItem; segmentIndex: number; position: number; deadline: number };
  private segmentIndex = 0;
  private lastSave = 0;
  private fullscreenPending = true;
  private disposed = false;
  private tracking = false;

  constructor(private library: Library) {
    const documents = library.list();
    this.playlist =
      documents.find(doc => doc.id === library.getSetting('activePlaylist')) ?? documents[0]!;
    this.autoFullscreen = library.getSetting('autoFullscreen') !== 'false';
    this.timer = setInterval(() => {
      void this.tick();
    }, 500);
  }

  state(): PlaybackState {
    return {
      playlist: this.playlist,
      snapshot: this.snapshot,
      running: this.running,
      autoFullscreen: this.autoFullscreen,
      error: this.error,
    };
  }

  attach(guest: WebContents) {
    this.guest = guest;
    guest.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      const differentVideo =
        isBilibiliUrl(url) &&
        this.snapshot.url &&
        playbackIdentity(url) !== playbackIdentity(this.snapshot.url);

      if (mainFrame && (!inPlace || differentVideo)) {
        this.fullscreenPending = true;
      }

      if (mainFrame && !inPlace) {
        this.tracking = false;
        this.snapshot = { ...emptySnapshot };
      }
    });
    guest.on('destroyed', () => {
      if (!this.disposed) {
        this.persist();
      }

      this.guest = undefined;
      this.running = false;
      this.pending = undefined;
    });
  }

  private getGuest(): WebContents {
    if (!this.guest || this.guest.isDestroyed() || !isBilibiliUrl(this.guest.getURL())) {
      throw new Error('B 站网页尚未就绪');
    }

    return this.guest;
  }

  private async execute(command: Command) {
    const guest = this.getGuest();
    const argument = JSON.stringify(command);
    // 参数单独序列化，播放器逻辑始终来自参与类型检查的注入模块。
    return await guest.executeJavaScript(
      `window.__bplaylistCommand = ${argument};\n${commandScript}`,
      true,
    );
  }

  async control(command: Command) {
    if (command.action === 'pause') {
      this.running = false;
      this.pending = undefined;
      this.generation++;
    }

    await this.execute(command);
    this.snapshot = snapshotSchema.parse(await this.getGuest().executeJavaScript(installScript));
    this.capture();
    this.persist();
  }

  async play(id: string, resume = true) {
    const item = flattenPlaylist(this.playlist.nodes).find(item => item.id === id);

    if (!item) {
      throw new Error('找不到播放条目');
    }

    if (/\/(ss|av)\d+/.test(new URL(item.url).pathname)) {
      const metadata = await this.resolveVideo(item.url);
      item.url = metadata.url;
      item.title = metadata.title;
      item.partTitle = metadata.partTitle;
    }

    this.capture();
    this.generation++;
    this.tracking = false;
    const progress = this.playlist.progress[id];

    const segments = playbackSegments(item);
    const savedIndex = progress?.segmentIndex ?? 0;
    const canResume = resume && progress && !progress.completed && savedIndex < segments.length;
    const index = canResume ? savedIndex : 0;
    const position = canResume ? Math.max(segments[index]!.start, progress.position) : item.start;

    this.playlist.activeItemId = id;

    if (progress) {
      progress.completed = false;
    }

    this.running = true;
    this.error = null;
    await this.beginSegment(item, index, position);
  }

  private async beginSegment(item: VideoItem, index: number, position: number) {
    const guest = this.getGuest();
    const segment = playbackSegments(item)[index]!;
    this.generation++;
    this.tracking = false;
    this.segmentIndex = index;
    this.pending = { item, segmentIndex: index, position, deadline: Date.now() + 45000 };
    this.fullscreenPending = true;
    this.persist();

    if (playbackIdentity(guest.getURL()) !== playbackIdentity(segment.url)) {
      this.snapshot = { ...emptySnapshot };
      await guest.loadURL(segment.url);
    }
  }

  async step(direction: number) {
    const queue = flattenPlaylist(this.playlist.nodes);
    const index = queue.findIndex(item => item.id === this.playlist.activeItemId);
    const next = queue[index + direction];

    if (next) {
      await this.play(next.id, false);
      return;
    }

    this.running = false;
    this.pending = undefined;
    this.persist();
  }

  async stop() {
    this.capture();
    this.tracking = false;
    this.running = false;
    this.pending = undefined;
    this.generation++;

    if (this.snapshot.available) {
      await this.execute({ action: 'pause' });
    }

    this.persist();
  }

  async navigate(url: string) {
    if (!isBilibiliUrl(url)) {
      throw new Error('仅支持 B 站 HTTPS 页面');
    }

    await this.getGuest().loadURL(url);
  }

  async resolveVideo(url: string) {
    const guest = this.getGuest();

    const result = await guest.executeJavaScript(
      `window.__bplaylistResolveUrl = ${JSON.stringify(url)};\n${resolveScript}`,
    );

    return z
      .object({
        title: z.string(),
        partTitle: z.string(),
        url: z.string(),
        parts: z.array(videoPartSchema),
      })
      .parse(result);
  }

  async select(id: string) {
    await this.stop();
    const document = this.library.list().find(doc => doc.id === id);

    if (!document) {
      throw new Error('播放列表不存在');
    }

    this.playlist = document;
    this.library.setSetting('activePlaylist', id);
  }

  async replace(document: Playlist) {
    const parsed = playlistSchema.parse(document);
    await this.stop();
    this.playlist = parsed;
    this.persist();
    this.library.setSetting('activePlaylist', parsed.id);
  }

  async edit(document: Playlist) {
    const parsed = playlistSchema.parse(document);

    if (parsed.id !== this.playlist.id) {
      throw new Error('当前列表已变化，请刷新后重试');
    }

    // 结构编辑不得用界面中稍旧的快照覆盖主进程刚收到的播放进度。
    const ids = new Set(parsed.nodes.map(node => node.id));
    const activeId = this.playlist.activeItemId;
    const before = this.playlist.nodes.find(node => node.id === activeId);
    const after = parsed.nodes.find(node => node.id === activeId);

    const playbackChanged = playbackSource(before) !== playbackSource(after);

    if (playbackChanged) {
      await this.stop();
    }

    parsed.progress = Object.fromEntries(
      Object.entries(this.playlist.progress).filter(
        ([id]) =>
          ids.has(id) &&
          playbackSource(this.playlist.nodes.find(node => node.id === id)) ===
            playbackSource(parsed.nodes.find(node => node.id === id)),
      ),
    );
    parsed.activeItemId = ids.has(this.playlist.activeItemId ?? '')
      ? this.playlist.activeItemId
      : null;

    if (!parsed.activeItemId) {
      this.running = false;
      this.pending = undefined;
    }

    this.playlist = parsed;
    this.persist();
    return parsed;
  }

  setFullscreen(value: boolean) {
    this.autoFullscreen = value;
    this.library.setSetting('autoFullscreen', String(value));
    this.fullscreenPending = value;
  }

  private capture() {
    const item = flattenPlaylist(this.playlist.nodes).find(
      item => item.id === this.playlist.activeItemId,
    );

    if (
      !item ||
      !this.tracking ||
      this.pending ||
      !this.snapshot.available ||
      playbackIdentity(playbackSegments(item)[this.segmentIndex]?.url ?? item.url) !==
        playbackIdentity(this.snapshot.url)
    ) {
      return;
    }

    const previous = this.playlist.progress[item.id];
    this.playlist.progress[item.id] = {
      ...(item.continuation ? { segmentIndex: this.segmentIndex } : {}),
      position: this.snapshot.position,
      duration: this.snapshot.duration,
      completed: previous?.completed ?? false,
      updatedAt: new Date().toISOString(),
    };
  }

  persist() {
    this.playlist.updatedAt = new Date().toISOString();
    this.library.save(this.playlist);
    this.lastSave = Date.now();
  }

  private async preparePending(generation: number): Promise<boolean> {
    if (
      !this.pending ||
      playbackIdentity(this.snapshot.url) !==
        playbackIdentity(playbackSegments(this.pending.item)[this.pending.segmentIndex]!.url)
    ) {
      return false;
    }

    const pending = this.pending;
    const segment = playbackSegments(pending.item)[pending.segmentIndex]!;
    const end = segment.end ?? this.snapshot.duration;

    if (segment.start >= this.snapshot.duration && this.snapshot.duration > 0) {
      throw new Error('片段开始时间超出视频时长');
    }

    const position = pending.position >= end && end > 0 ? segment.start : pending.position;
    await this.execute({ action: 'seek', position });

    if (generation !== this.generation) {
      return true;
    }

    await this.execute({ action: 'play' });

    if (generation === this.generation) {
      this.pending = undefined;
      this.tracking = true;
    }

    return true;
  }

  private async finishCurrent(generation: number) {
    const item = flattenPlaylist(this.playlist.nodes).find(
      item => item.id === this.playlist.activeItemId,
    );

    if (
      !item ||
      this.pending ||
      playbackIdentity(playbackSegments(item)[this.segmentIndex]!.url) !==
        playbackIdentity(this.snapshot.url)
    ) {
      return;
    }

    this.capture();
    const segments = playbackSegments(item);
    const segment = segments[this.segmentIndex]!;

    const ended =
      this.snapshot.ended || (segment.end !== null && this.snapshot.position >= segment.end);

    if (!this.running || !ended) {
      return;
    }

    await this.execute({ action: 'pause' });

    if (generation !== this.generation) {
      return;
    }

    if (this.segmentIndex < segments.length - 1) {
      const nextIndex = this.segmentIndex + 1;
      this.playlist.progress[item.id] = {
        segmentIndex: nextIndex,
        position: 0,
        duration: 0,
        completed: false,
        updatedAt: new Date().toISOString(),
      };
      await this.beginSegment(item, nextIndex, 0);
      return;
    }

    this.completeItem(item, segment.end);
    await this.step(1);
  }

  private completeItem(item: VideoItem, end: number | null) {
    this.playlist.progress[item.id] = {
      ...(item.continuation ? { segmentIndex: this.segmentIndex } : {}),
      position: Math.min(this.snapshot.position, end ?? this.snapshot.duration),
      duration: this.snapshot.duration,
      completed: true,
      updatedAt: new Date().toISOString(),
    };
  }

  private async ensureFullscreen() {
    if (!this.fullscreenPending) {
      return;
    }

    if (!this.autoFullscreen || this.snapshot.webFullscreen) {
      this.fullscreenPending = false;
      return;
    }

    const applied = await this.execute({ action: 'fullscreen' });
    this.fullscreenPending = applied === false;
  }

  private readyGuest() {
    const guest = this.guest;
    return guest &&
      !guest.isDestroyed() &&
      !guest.isLoadingMainFrame() &&
      isBilibiliUrl(guest.getURL())
      ? guest
      : null;
  }

  private checkDeadline() {
    if (this.pending && Date.now() > this.pending.deadline) {
      throw new Error('等待播放器超时，请检查登录、网络或视频权限后重试');
    }
  }

  private handleError(error: unknown, generation: number) {
    if (generation === this.generation && !this.guest?.isLoadingMainFrame()) {
      this.error = error instanceof Error ? error.message : String(error);
      this.running = false;
      this.pending = undefined;
    }
  }

  private async tick() {
    if (this.busy || this.disposed) {
      return;
    }

    const guest = this.readyGuest();

    if (!guest) {
      return;
    }

    this.busy = true;
    const generation = this.generation;

    try {
      const snapshot = snapshotSchema.parse(await guest.executeJavaScript(installScript));

      if (generation !== this.generation) {
        return;
      }

      this.snapshot = snapshot;

      this.checkDeadline();

      if (!snapshot.available) {
        return;
      }

      if (await this.preparePending(generation)) {
        return;
      }

      await this.ensureFullscreen();

      if (generation !== this.generation) {
        return;
      }

      await this.finishCurrent(generation);

      if (Date.now() - this.lastSave >= 5000) {
        this.persist();
      }
    } catch (error) {
      this.handleError(error, generation);
    } finally {
      this.busy = false;
    }
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    clearInterval(this.timer);
    this.capture();
    this.persist();
  }
}
