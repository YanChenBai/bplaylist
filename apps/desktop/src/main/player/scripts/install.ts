import type { PlayerSnapshot } from '@bplaylist/shared';

interface PageBridge {
  read(): PlayerSnapshot;
  command(command: {
    action: 'play' | 'pause' | 'seek' | 'fullscreen';
    position?: number;
  }): Promise<boolean | void>;
}

interface BiliPage extends Window {
  __bplaylistAudioOffset?: { error: string };
  __bplaylistRange?: PlaybackRange | null;
  __bplaylist?: PageBridge;
  __INITIAL_STATE__?: {
    videoData?: { bvid?: string; title?: string; pages?: { page: number; part: string }[] };
    epList?: { id: number; title: string; long_title?: string }[];
    epInfo?: { id: number; title: string; long_title?: string };
    mediaInfo?: { title?: string };
  };
}

interface EpisodeMetadata {
  id: number;
  title: string;
  long_title?: string;
}

interface SeasonMetadata {
  title: string;
  episodes?: EpisodeMetadata[];
  section?: { episodes: EpisodeMetadata[] }[];
}

export default function install() {
  const page = window as BiliPage;

  if (page.__bplaylist) {
    return page.__bplaylist.read();
  }

  let video: HTMLVideoElement | null = null;
  let managed = false;
  let season: SeasonMetadata | null = null;
  let seasonPath = '';

  const loadSeason = () => {
    const match = /\/bangumi\/play\/(ep|ss)(\d+)/.exec(location.pathname);

    if (!match || seasonPath === location.pathname) {
      return;
    }

    seasonPath = location.pathname;
    season = null;
    const path = seasonPath;
    const parameter = match[1] === 'ep' ? `ep_id=${match[2]}` : `season_id=${match[2]}`;
    void fetch(`https://api.bilibili.com/pgc/view/web/season?${parameter}`, {
      credentials: 'include',
      signal: AbortSignal.timeout(15000),
    })
      .then(response => response.json() as Promise<{ code: number; result?: SeasonMetadata }>)
      .then(result => {
        if (seasonPath === path && result.code === 0 && result.result) {
          season = result.result;
        }
      })
      .catch(error => console.warn('BPlaylist 分集信息读取失败', error));
  };

  const allEpisodes = () => [
    ...(season?.episodes ?? []),
    ...(season?.section ?? []).flatMap(section => section.episodes),
  ];

  let observed = { position: 0, duration: 0, paused: true, ended: false };

  const update = () => {
    if (video) {
      observed = {
        position: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        paused: video.paused,
        ended: video.ended,
      };
    }
  };

  const events = [
    'timeupdate',
    'durationchange',
    'loadedmetadata',
    'play',
    'pause',
    'ended',
    'seeked',
  ];

  const onEnded = (event: Event) => {
    update();

    if (managed) {
      event.stopImmediatePropagation();
    }
  };

  const bind = () => {
    const current = document.querySelector<HTMLVideoElement>(
      '.bpx-player-video-wrap video, .bilibili-player-video video, video',
    );

    if (current === video) {
      return;
    }

    for (const event of events) {
      video?.removeEventListener(event, update);
      current?.addEventListener(event, update);
    }

    video?.removeEventListener('ended', onEnded, true);
    current?.addEventListener('ended', onEnded, true);

    video = current;
    observed = { position: 0, duration: 0, paused: true, ended: false };
    update();
  };

  const fullscreen = () =>
    Boolean(
      document.querySelector(
        '.bpx-player-container.bpx-state-web, .bpx-player-container[data-screen="web"], .bilibili-player.mode-webfullscreen',
      ),
    );

  const enterWebFullscreen = () => {
    if (document.fullscreenElement || fullscreen()) {
      return true;
    }

    const button = document.querySelector<HTMLElement>(
      '.bpx-player-ctrl-web, .bilibili-player-video-web-fullscreen',
    );

    if (!button || button.matches(':disabled, [aria-disabled="true"]')) {
      return false;
    }

    button.click();
    return true;
  };

  const videoParts = () => {
    const state = page.__INITIAL_STATE__;
    const data = state?.videoData;
    const bvid = data?.bvid ?? location.pathname.split('/')[2];
    return (data?.pages ?? []).map(part => ({
      title: `P${part.page} · ${part.part}`,
      url: `https://www.bilibili.com/video/${bvid}?p=${part.page}`,
    }));
  };

  const episodeParts = () =>
    (season ? allEpisodes() : (page.__INITIAL_STATE__?.epList ?? [])).map(ep => ({
      title: `${ep.title} ${ep.long_title ?? ''}`.trim(),
      url: `https://www.bilibili.com/bangumi/play/ep${ep.id}`,
    }));

  const currentPart = () => {
    const currentPage = Number(new URL(location.href).searchParams.get('p') || 1);
    const part = page.__INITIAL_STATE__?.videoData?.pages?.find(part => part.page === currentPage);
    const currentEpisode = Number(/\/ep(\d+)/.exec(location.pathname)?.[1]);

    const episode =
      allEpisodes().find(ep => ep.id === currentEpisode) ?? page.__INITIAL_STATE__?.epInfo;

    return part
      ? `P${part.page} · ${part.part}`
      : [episode?.title, episode?.long_title].filter(Boolean).join(' · ');
  };

  const pageTitle = () => {
    const state = page.__INITIAL_STATE__;

    const candidates = [
      season?.title,
      state?.videoData?.title,
      state?.mediaInfo?.title,
      document.querySelector('h1')?.textContent?.trim(),
      document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content,
      document.title.replace(/_哔哩哔哩.*$/, ''),
    ];

    return candidates.find(Boolean) ?? '';
  };

  const metadata = () => {
    const parts = videoParts();
    return {
      title: pageTitle(),
      partTitle: currentPart(),
      parts: parts.length ? parts : episodeParts(),
    };
  };

  page.__bplaylist = {
    read() {
      loadSeason();
      bind();
      update();
      updateRangeOverlay(page.__bplaylistRange, observed.duration);
      return {
        url: location.href,
        ...metadata(),
        available: Boolean(video && video.readyState >= 1),
        ...observed,
        webFullscreen: fullscreen(),
        audioOffsetError: page.__bplaylistAudioOffset?.error || undefined,
      };
    },
    async command(command) {
      bind();

      if (!video) {
        throw new Error('播放器尚未就绪');
      }

      if (command.action === 'fullscreen') {
        return enterWebFullscreen();
      }

      if (command.action === 'seek') {
        const position = command.position ?? 0;

        if (!Number.isFinite(position) || position < 0) {
          throw new Error('无效的播放时间');
        }

        video.currentTime = Math.min(
          position,
          Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : position,
        );
      }

      if (command.action === 'play') {
        managed = true;
        await video.play();
      }

      if (command.action === 'pause') {
        video.pause();
      }

      update();
    },
  };

  // 页面切换或播放器重建时，下次读取会重新绑定 video 事件。
  return page.__bplaylist.read();
}

interface PlaybackRange {
  url: string;
  start: number;
  end: number | null;
}

function sourceIdentity(value: string) {
  const url = new URL(value);
  return `${url.pathname.replace(/\/$/, '')}?p=${url.searchParams.get('p') || '1'}`;
}

/** 粉色范围位于原生轨道内，蓝色已播放进度保持在前景。 */
function updateRangeOverlay(range: PlaybackRange | null | undefined, duration: number) {
  if (
    !range ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    sourceIdentity(range.url) !== sourceIdentity(location.href)
  ) {
    clearRangeOverlay();
    return;
  }

  const start = Math.min(duration, Math.max(0, range.start));
  const end = Math.min(duration, range.end ?? duration);

  if (end <= start) {
    clearRangeOverlay();
    return;
  }

  const markers = new Set<HTMLElement>();

  const tracks = document.querySelectorAll<HTMLElement>(
    '.bpx-player-progress, .bpx-player-shadow-progress-schedule-wrap, .bilibili-player-video-progress',
  );

  for (const track of tracks) {
    const marker = rangeTrackOverlay(track);
    markers.add(marker);
    marker.style.left = `${(start / duration) * 100}%`;
    marker.style.width = `${((end - start) / duration) * 100}%`;
  }

  document.querySelectorAll<HTMLElement>('[data-bplaylist-range]').forEach(marker => {
    if (!markers.has(marker)) {
      marker.remove();
    }
  });
  restoreRangeLayers();
}

function rangeTrackOverlay(track: HTMLElement) {
  const foreground = track.querySelector<HTMLElement>(
    '.bui-bar-progress, .bpx-player-progress-schedule-current, .bpx-player-shadow-progress-schedule, .bilibili-player-video-progress-now',
  );

  const rail = foreground?.parentElement ?? track;

  if (!rail.hasAttribute('data-bplaylist-range-rail')) {
    rail.dataset.bplaylistRangeRail = rail.style.position;
    rail.dataset.bplaylistRangeIsolation = rail.style.isolation;
  }

  if (getComputedStyle(rail).position === 'static') {
    rail.style.position = 'relative';
  }

  rail.style.isolation = 'isolate';

  let marker = rail.querySelector<HTMLElement>(':scope > [data-bplaylist-range]');

  if (!marker) {
    marker = document.createElement('span');
    marker.dataset.bplaylistRange = '';
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText =
      'position:absolute;top:0;bottom:0;pointer-events:none;background:#FF6699;opacity:1;z-index:1;border-radius:inherit;';
    rail.prepend(marker);
  }

  if (foreground) {
    raiseRangeForeground(foreground, marker);
  }

  return marker;
}

function raiseRangeForeground(foreground: HTMLElement, marker: HTMLElement) {
  if (!foreground.hasAttribute('data-bplaylist-range-foreground')) {
    const originalZ = Number.parseInt(getComputedStyle(foreground).zIndex, 10) || 0;
    foreground.dataset.bplaylistRangeLayer = String(Math.max(1, originalZ + 1));
    foreground.dataset.bplaylistRangeForeground = foreground.style.zIndex;
    foreground.dataset.bplaylistRangePosition = foreground.style.position;
  }

  const layer = Number(foreground.dataset.bplaylistRangeLayer) || 1;
  marker.style.zIndex = String(layer);

  if (getComputedStyle(foreground).position === 'static') {
    foreground.style.position = 'relative';
  }

  foreground.style.zIndex = String(layer + 1);
}

function clearRangeOverlay() {
  document
    .querySelectorAll('[data-bplaylist-range], [data-bplaylist-range-track]')
    .forEach(element => element.remove());
  restoreRangeLayers();
}

function restoreRangeLayers() {
  document.querySelectorAll<HTMLElement>('[data-bplaylist-range-foreground]').forEach(element => {
    if (element.parentElement?.querySelector(':scope > [data-bplaylist-range]')) {
      return;
    }

    element.style.zIndex = element.dataset.bplaylistRangeForeground ?? '';
    element.style.position = element.dataset.bplaylistRangePosition ?? '';
    delete element.dataset.bplaylistRangeLayer;
    delete element.dataset.bplaylistRangeForeground;
    delete element.dataset.bplaylistRangePosition;
  });
  document.querySelectorAll<HTMLElement>('[data-bplaylist-range-rail]').forEach(element => {
    if (element.querySelector(':scope > [data-bplaylist-range]')) {
      return;
    }

    element.style.position = element.dataset.bplaylistRangeRail ?? '';
    element.style.isolation = element.dataset.bplaylistRangeIsolation ?? '';
    delete element.dataset.bplaylistRangeIsolation;
    delete element.dataset.bplaylistRangeRail;
  });
}
