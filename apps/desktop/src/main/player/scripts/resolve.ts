interface ResolvePage extends Window {
  __bplaylistResolveUrl?: string;
}

interface Episode {
  id: number;
  title: string;
  long_title?: string;
}

export default async function resolveVideo() {
  const page = window as ResolvePage;
  const input = page.__bplaylistResolveUrl;
  delete page.__bplaylistResolveUrl;

  if (!input) {
    throw new Error('视频地址为空');
  }

  const url = new URL(input);
  const match = /\/video\/(BV[\da-z]+|av\d+)/i.exec(url.pathname);

  if (match) {
    return resolveUpload(url, match[1]!);
  }

  return resolveEpisode(url);
}

async function resolveUpload(url: URL, identifier: string) {
  const parameter = identifier.startsWith('av')
    ? `aid=${identifier.slice(2)}`
    : `bvid=${identifier}`;

  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?${parameter}`, {
    credentials: 'include',
    signal: AbortSignal.timeout(15000),
  });

  const result = (await response.json()) as {
    code: number;
    message?: string;
    data?: { bvid: string; title: string; pages: { page: number; part: string }[] };
  };

  if (result.code !== 0 || !result.data) {
    throw new Error(result.message || '无法读取视频信息');
  }

  const partNumber = Number(url.searchParams.get('p') || 1);
  const part = result.data.pages.find(part => part.page === partNumber);

  if (!part) {
    throw new Error('该视频不存在指定分 P');
  }

  return {
    title: result.data.title,
    partTitle: `P${part.page} · ${part.part}`,
    url: `https://www.bilibili.com/video/${result.data.bvid}?p=${part.page}`,
    parts: result.data.pages.map(part => ({
      title: `P${part.page} · ${part.part}`,
      url: `https://www.bilibili.com/video/${result.data!.bvid}?p=${part.page}`,
    })),
  };
}

async function resolveEpisode(url: URL) {
  const episode = /\/bangumi\/play\/(ep|ss)(\d+)/.exec(url.pathname);

  if (!episode) {
    throw new Error('不支持的视频地址');
  }

  const parameter = episode[1] === 'ep' ? `ep_id=${episode[2]}` : `season_id=${episode[2]}`;

  const response = await fetch(`https://api.bilibili.com/pgc/view/web/season?${parameter}`, {
    credentials: 'include',
    signal: AbortSignal.timeout(15000),
  });

  const result = (await response.json()) as {
    code: number;
    message?: string;
    result?: { title: string; episodes?: Episode[]; section?: { episodes: Episode[] }[] };
  };

  if (result.code !== 0 || !result.result) {
    throw new Error(result.message || '无法读取分集信息');
  }

  const data = result.result;

  const episodes = [
    ...(data.episodes ?? []),
    ...(data.section ?? []).flatMap(section => section.episodes),
  ];

  const selected =
    episode[1] === 'ep' ? episodes.find(item => item.id === Number(episode[2])) : episodes[0];

  if (!selected) {
    throw new Error('找不到该分集，可能需要登录或当前账号没有访问权限');
  }

  return {
    title: data.title,
    partTitle: [selected.title, selected.long_title].filter(Boolean).join(' · '),
    url: `https://www.bilibili.com/bangumi/play/ep${selected.id}?p=1`,
    parts: episodes.map(item => ({
      title: [item.title, item.long_title].filter(Boolean).join(' · '),
      url: `https://www.bilibili.com/bangumi/play/ep${item.id}?p=1`,
    })),
  };
}
