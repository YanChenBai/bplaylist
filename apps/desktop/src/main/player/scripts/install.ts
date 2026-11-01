import type { PlayerSnapshot } from '@bplaylist/shared';

interface PageBridge {
  read(): PlayerSnapshot;
  command(command: {
    action: 'play' | 'pause' | 'seek' | 'fullscreen';
    position?: number;
  }): Promise<void>;
}

interface BiliPage extends Window {
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
      return {
        url: location.href,
        ...metadata(),
        available: Boolean(video && video.readyState >= 1),
        ...observed,
        webFullscreen: fullscreen(),
      };
    },
    async command(command) {
      bind();

      if (!video) {
        throw new Error('播放器尚未就绪');
      }

      if (command.action === 'fullscreen') {
        if (!fullscreen()) {
          document
            .querySelector<HTMLElement>(
              '.bpx-player-ctrl-web, .bilibili-player-video-web-fullscreen',
            )
            ?.click();
        }

        return;
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
