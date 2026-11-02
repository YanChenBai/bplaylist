(() => {
  const video = document.querySelector('video');

  function readParts(state, data, media) {
    const episodes = state.epList || media.episodes || [];
    const pages = data.pages || [];

    return pages.length
      ? pages.map((page, index) => ({
          title: `P${index + 1} · ${page.part || ''}`,
          url: `${location.origin}${location.pathname}?p=${index + 1}`,
        }))
      : episodes.map(episode => ({
          title: episode.long_title || episode.longTitle || episode.title || '',
          url: `https://www.bilibili.com/bangumi/play/ep${episode.id}`,
        }));
  }

  function partIdentity(value) {
    const url = new URL(value);
    return `${url.pathname.replace(/\/$/, '')}?p=${url.searchParams.get('p') || '1'}`;
  }

  function readMetadata() {
    const state = window.__INITIAL_STATE__ || {};
    const data = state.videoData || {};
    const media = state.mediaInfo || {};
    const parts = readParts(state, data, media);
    const current = parts.find(part => partIdentity(part.url) === partIdentity(location.href));

    return {
      title:
        data.title ||
        media.title ||
        document.querySelector('h1')?.textContent?.trim() ||
        document.title,
      partTitle: current?.title || '',
      parts,
    };
  }

  function updateRange(video) {
    const range = window.__bplaylistRange;

    if (!video || !range || !Number.isFinite(video.duration) || video.duration <= 0) {
      return;
    }

    for (const track of document.querySelectorAll(
      '.bpx-player-progress,.bpx-player-shadow-progress-schedule-wrap',
    )) {
      const marker = rangeMarker(track);
      marker.style.left = `${(range.start / video.duration) * 100}%`;
      marker.style.width = `${Math.max(0, ((Math.min(range.end ?? video.duration, video.duration) - range.start) / video.duration) * 100)}%`;
    }
  }

  function rangeMarker(track) {
    const fill = track.querySelector(
      '.bui-bar-progress,.bpx-player-progress-schedule-current,.bpx-player-shadow-progress-schedule',
    );

    const rail = fill?.parentElement || track;
    let marker = rail.querySelector('[data-bplaylist-range]');

    if (!marker) {
      marker = document.createElement('span');
      marker.dataset.bplaylistRange = '';

      if (getComputedStyle(rail).position === 'static') {
        rail.style.position = 'relative';
      }

      rail.style.isolation = 'isolate';
      marker.style.cssText =
        'position:absolute;top:0;bottom:0;background:#FF6699;pointer-events:none;z-index:1';
      rail.prepend(marker);

      if (fill) {
        if (getComputedStyle(fill).position === 'static') {
          fill.style.position = 'relative';
        }

        fill.style.zIndex = '2';
      }
    }

    return marker;
  }

  updateRange(video);

  function readPlayback(video) {
    return {
      url: location.href,
      available: Boolean(video),
      position: video?.currentTime || 0,
      duration: Number.isFinite(video?.duration) ? video.duration : 0,
      paused: video?.paused ?? true,
      seeking: video?.seeking ?? false,
      ended: video?.ended ?? false,
      webFullscreen: Boolean(document.querySelector('.bpx-state-web,.mode-webscreen')),
    };
  }

  return { ...readMetadata(), ...readPlayback(video) };
})();
