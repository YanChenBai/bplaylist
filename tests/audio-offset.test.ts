import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const script = readFileSync(
  new URL('../packages/shared/src/audio-offset.js', import.meta.url),
  'utf8',
);

class Media extends EventTarget {
  currentTime = 10;
  duration = 100;
  readyState = 4;
  paused = false;
  ended = false;
  seeking = false;
  muted = false;
  volume = 0.7;
  playbackRate = 1;
  currentSrc = 'blob:https://www.bilibili.com/video';
  crossOrigin = 'anonymous';
  mediaKeys = null;
  src = '';
  preload = '';

  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });

  pause() {
    this.paused = true;
  }

  removeAttribute() {}

  load() {}
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function fixture(offset: number) {
  vi.useFakeTimers();
  const video = new Media();
  const tracks: Media[] = [];
  const gain = { gain: { value: 1 }, connect: vi.fn() };
  const source = { connect: vi.fn(() => gain) };
  const createSource = vi.fn(() => source);

  const page = {
    __bplaylistRange: {
      url: 'https://www.bilibili.com/video/BV1GJ411x7h7?p=1',
      audioOffsetMs: offset,
    },
    player: {
      __core: () => ({ getCurrentPlayURLFor: () => 'https://media.bilivideo.com/audio.m4s' }),
    },
    __bplaylistAudioOffset: undefined as unknown as { error: string },
  };

  const context = createContext({
    window: page,
    document: { querySelector: () => video },
    location: { href: page.__bplaylistRange.url },
    URL,
    setInterval,
    clearInterval,
    Audio: class extends Media {
      constructor() {
        super();
        this.currentTime = 0;
        this.paused = true;
        tracks.push(this);
      }
    },
    AudioContext: class {
      state = 'running';
      destination = {};
      resume = () => Promise.resolve();
      close = () => Promise.resolve();
      createMediaElementSource = createSource;
      createGain = () => gain;
    },
  });

  const update = async (value: number) => {
    page.__bplaylistRange.audioOffsetMs = value;
    runInContext(script, context);
    await flush();
  };

  await update(offset);
  return { video, tracks, gain, page, update, createSource };
}

afterEach(() => vi.useRealTimers());

describe('固定声音偏移注入', () => {
  it.each([500, -500])('偏移 %i ms 后音轨位置正确，原视频时间和静音设置保持不变', async offset => {
    const { video, tracks, gain } = await fixture(offset);
    expect(tracks[0]!.currentTime).toBe(10 - offset / 1000);
    expect(tracks[0]!.paused).toBe(false);
    expect(gain.gain.value).toBe(0);
    expect(video.currentTime).toBe(10);
    expect(video.muted).toBe(false);
  });

  it('暂停、跳转、倍速和音量变化同步到独立音轨', async () => {
    const { video, tracks, gain } = await fixture(-600);
    const audio = tracks[0]!;
    video.paused = true;
    video.dispatchEvent(new Event('pause'));
    expect(audio.paused).toBe(true);
    video.currentTime = 30;
    video.seeking = true;
    video.paused = false;
    video.dispatchEvent(new Event('seeking'));
    expect(audio.paused).toBe(true);
    video.seeking = false;
    video.playbackRate = 1.5;
    video.volume = 0.3;
    video.muted = true;
    video.dispatchEvent(new Event('seeked'));
    await flush();
    expect(audio.currentTime).toBe(30.6);
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.volume).toBe(0.3);
    expect(audio.muted).toBe(true);
    expect(gain.gain.value).toBe(0);
  });

  it('更改偏移不叠加，重置恢复原声并释放音轨和计时器', async () => {
    const { tracks, gain, update, createSource } = await fixture(400);
    await update(-300);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]!.paused).toBe(true);
    expect(tracks[1]!.currentTime).toBe(10.3);
    expect(createSource).toHaveBeenCalledTimes(1);
    await update(0);
    expect(tracks[1]!.paused).toBe(true);
    expect(gain.gain.value).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('延后时开头保持静音，提前时音轨结束后保持静音', async () => {
    const { video, tracks, gain } = await fixture(500);
    video.currentTime = 0.2;
    await vi.advanceTimersByTimeAsync(100);
    expect(tracks[0]!.paused).toBe(true);
    expect(gain.gain.value).toBe(0);
    video.currentTime = 0.6;
    await vi.advanceTimersByTimeAsync(100);
    expect(tracks[0]!.currentTime).toBeCloseTo(0.1);
    expect(tracks[0]!.paused).toBe(false);
  });

  it('加载失败恢复原声，重复快照不重复创建失败音轨', async () => {
    const { tracks, gain, page, update } = await fixture(500);
    tracks[0]!.dispatchEvent(new Event('error'));
    expect(gain.gain.value).toBe(1);
    expect(page.__bplaylistAudioOffset.error).toContain('已保留原声');
    await update(500);
    expect(tracks).toHaveLength(1);
    await update(0);
    expect(page.__bplaylistAudioOffset.error).toBe('');
  });

  it('跨页面时不把原条目的偏移应用到其他视频', async () => {
    const { tracks, gain, page, update } = await fixture(500);
    page.__bplaylistRange.url = 'https://www.bilibili.com/video/BV1XSMpzdEWD';
    await update(500);
    expect(tracks[0]!.paused).toBe(true);
    expect(gain.gain.value).toBe(1);
  });
});
