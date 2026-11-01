interface CommandPage extends Window {
  __bplaylistCommand?: { action: 'play' | 'pause' | 'seek' | 'fullscreen'; position?: number };
  __bplaylist?: { command(command: NonNullable<CommandPage['__bplaylistCommand']>): Promise<void> };
}

export default async function command() {
  const page = window as CommandPage;
  const input = page.__bplaylistCommand;
  delete page.__bplaylistCommand;

  if (!input || !page.__bplaylist) {
    throw new Error('播放器适配器尚未初始化');
  }

  await page.__bplaylist.command(input);
}
