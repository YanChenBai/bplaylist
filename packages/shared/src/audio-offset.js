// 独立注入脚本，桌面端与 Android 共用；不向页面暴露宿主能力。
(() => {
  if (!window.__bplaylistAudioOffset) {
    const graphs = new WeakMap();
    let session;
    let failedKey = '';
    let error = '';

    function restore() {
      if (!session) {
        return;
      }

      const previous = session;
      session = undefined;
      clearInterval(previous.timer);

      for (const event of previous.events) {
        previous.video.removeEventListener(event, previous.sync);
      }

      previous.audio.pause();
      previous.audio.removeAttribute('src');
      previous.audio.load();
      const graph = graphs.get(previous.video);

      if (graph) {
        graph.gain.gain.value = 1;
      }
    }

    function fail(current, message) {
      if (session !== current) {
        return;
      }

      failedKey = current.key;
      error = `${message}，已保留原声`;
      restore();
    }

    function audioUrl() {
      try {
        const source = window.player?.__core?.()?.getCurrentPlayURLFor?.('audio');
        const data = window.__playinfo__?.data ?? window.__playinfo__?.result?.video_info;
        const track = data?.dash?.audio?.[0];
        const url = source || track?.baseUrl || track?.base_url;

        if (url && new URL(url).protocol === 'https:') {
          return url;
        }
      } catch {
        // 页面播放器切换时，下一次快照读取会重新尝试。
      }

      return '';
    }

    function sync(current) {
      if (session !== current) {
        return;
      }

      const { video, audio, offset } = current;
      const graph = graphs.get(video);

      if (!graph || graph.context.state !== 'running') {
        return;
      }

      audio.volume = video.volume;
      audio.playbackRate = video.playbackRate;

      if (video.paused || video.ended || video.seeking || video.readyState < 3) {
        audio.pause();
        return;
      }

      if (audio.readyState < 2) {
        return;
      }

      const target = video.currentTime - offset / 1000;

      if (target < 0 || target >= audio.duration) {
        audio.pause();
        graph.gain.gain.value = 0;
        return;
      }

      if (!current.starting && (audio.paused || Math.abs(audio.currentTime - target) > 0.08)) {
        audio.currentTime = target;
      }

      if (!audio.paused) {
        graph.gain.gain.value = 0;
        audio.muted = video.muted;
        return;
      }

      if (current.starting) {
        return;
      }

      current.starting = true;
      audio.muted = true;
      void audio.play().then(
        () => {
          current.starting = false;

          if (session !== current || video.paused || video.seeking) {
            audio.pause();
            return;
          }

          graph.gain.gain.value = 0;
          audio.muted = video.muted;
        },
        cause => {
          current.starting = false;

          if (cause.name !== 'AbortError') {
            fail(current, '声音偏移音轨播放失败');
          }
        },
      );
    }

    async function start(current) {
      try {
        let graph = graphs.get(current.video);

        if (!graph) {
          // 先确认音频上下文可运行，再接管原声，防止自动播放限制导致静音。
          const context = new AudioContext();
          current.context = context;
          await context.resume();

          if (session !== current) {
            await context.close();
            return;
          }

          const source = context.createMediaElementSource(current.video);
          const gain = context.createGain();
          source.connect(gain).connect(context.destination);
          graph = { context, source, gain };
          graphs.set(current.video, graph);
        } else {
          await graph.context.resume();
        }

        if (session === current) {
          current.sync();
        }
      } catch {
        if (!graphs.has(current.video)) {
          void current.context?.close();
        }

        fail(current, '当前播放器不支持声音偏移');
      }
    }

    window.__bplaylistAudioOffset = {
      get error() {
        return error;
      },
      update(video, offset, identity) {
        if (!video || !offset) {
          restore();
          failedKey = '';
          error = '';
          return;
        }

        const url = audioUrl();
        const key = `${identity}|${video.currentSrc}|${offset}|${url}`;

        if (session?.video === video && session.key === key) {
          session.sync();
          return;
        }

        restore();

        if (failedKey === key) {
          return;
        }

        error = '';

        if (
          !url ||
          video.mediaKeys ||
          (!video.crossOrigin && !video.currentSrc.startsWith('blob:'))
        ) {
          error = '当前视频无法读取可偏移音轨，已保留原声';
          return;
        }

        const audio = new Audio();

        const current = {
          video,
          audio,
          offset,
          key,
          events: [
            'playing',
            'pause',
            'waiting',
            'seeking',
            'seeked',
            'ratechange',
            'volumechange',
            'ended',
          ],
          sync: () => sync(current),
          starting: false,
        };

        session = current;
        audio.preload = 'auto';
        audio.muted = true;
        audio.addEventListener('error', () => fail(current, '声音偏移音轨加载失败'));
        audio.addEventListener('loadeddata', current.sync);
        audio.src = url;

        for (const event of current.events) {
          video.addEventListener(event, current.sync);
        }

        current.timer = setInterval(current.sync, 100);
        void start(current);
      },
    };
  }

  const range = window.__bplaylistRange;

  const identity = value => {
    const url = new URL(value);
    return `${url.pathname.replace(/\/$/, '')}?p=${url.searchParams.get('p') || '1'}`;
  };

  const matches = range?.url && identity(range.url) === identity(location.href);
  const offset = matches ? (range.audioOffsetMs ?? 0) : 0;
  window.__bplaylistAudioOffset.update(
    document.querySelector('.bpx-player-video-wrap video, .bilibili-player-video video, video'),
    Number.isInteger(offset) && Math.abs(offset) <= 10000 ? offset : 0,
    identity(location.href),
  );
})();
