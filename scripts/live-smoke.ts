import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/desktop/package.json'));

const userData = await mkdtemp(join(tmpdir(), 'bplaylist-live-'));
const env: Record<string, string> = { ...process.env, BPLAYLIST_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: require('electron'),
  args: [join(root, 'apps/desktop')],
  env,
});

try {
  const page = await app.firstWindow();
  await page.getByRole('main', { name: 'BPlaylist 工作区', exact: true }).waitFor();

  const read = () =>
    app.evaluate(async ({ webContents }) => {
      const guest = webContents
        .getAllWebContents()
        .find(contents => contents.getType() === 'webview')!;

      return {
        url: guest.getURL(),
        loading: guest.isLoadingMainFrame(),
        snapshot: await guest.executeJavaScript('window.__bplaylist?.read() ?? null'),
      };
    });

  await expect.poll(async () => (await read()).url, { timeout: 20000 }).toContain('bilibili.com');
  await expect.poll(async () => (await read()).loading, { timeout: 20000 }).toBe(false);
  await expect(page.getByRole('combobox', { name: '切换播放列表' })).toContainText('我的播放列表');

  const clicked = await app.evaluate(async ({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find(contents => contents.getType() === 'webview')!;

    const target = await guest.executeJavaScript(
      `(() => { const link = [...document.querySelectorAll('a[href*="/video/BV"]')].find(link => link.getBoundingClientRect().width > 20); if (!link) return null; link.scrollIntoView({block:'center'}); const r=link.getBoundingClientRect(); return {url:link.href,target:link.target,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
    );

    if (!target) {
      throw new Error('首页未找到可点击的视频链接');
    }

    guest.sendInputEvent({
      type: 'mouseDown',
      x: target.x,
      y: target.y,
      button: 'left',
      clickCount: 1,
    });
    guest.sendInputEvent({
      type: 'mouseUp',
      x: target.x,
      y: target.y,
      button: 'left',
      clickCount: 1,
    });
    return target;
  });

  await expect.poll(async () => (await read()).url, { timeout: 30000 }).toContain('/video/BV');
  process.stdout.write(
    `Homepage click navigated in webview: ${clicked.url} (target=${clicked.target})\n`,
  );
  await expect.poll(async () => (await read()).loading, { timeout: 30000 }).toBe(false);
  await page
    .getByRole('textbox', { name: 'B 站网址' })
    .fill('https://www.bilibili.com/bangumi/play/ep6613853');
  await page.getByRole('textbox', { name: 'B 站网址' }).press('Enter');
  await expect
    .poll(async () => (await read()).url, { timeout: 45000 })
    .toContain('/bangumi/play/ep6613853');
  await expect
    .poll(async () => (await read()).snapshot?.title ?? '', { timeout: 45000 })
    .not.toBe('');
  const state = await read();
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);

  await expect
    .poll(async () => (await read()).snapshot?.webFullscreen, { timeout: 15000 })
    .toBe(true);
  await expect
    .poll(async () => (await read()).snapshot?.partTitle ?? '', { timeout: 20000 })
    .toContain('107');
  await expect
    .poll(async () => (await read()).snapshot?.parts.length ?? 0, { timeout: 20000 })
    .toBeGreaterThan(1);
  process.stdout.write(`Live page: web fullscreen and episode metadata verified.\n`);
  await app.evaluate(async ({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find(contents => contents.getType() === 'webview')!;

    await guest.executeJavaScript(
      "document.querySelector('.bpx-player-ctrl-web, .bilibili-player-video-web-fullscreen').click()",
      true,
    );
  });
  await page.waitForTimeout(1500);
  await expect.poll(async () => (await read()).snapshot?.webFullscreen).toBe(false);
  await app.evaluate(async ({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find(contents => contents.getType() === 'webview')!;

    await guest.executeJavaScript(
      "document.querySelector('.bpx-player-ctrl-full, .bilibili-player-video-btn-fullscreen').click()",
      true,
    );
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen()),
    )
    .toBe(true);
  await expect
    .poll(() => page.locator('webview').evaluate(element => getComputedStyle(element).position))
    .toBe('fixed');
  await app.evaluate(({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find(contents => contents.getType() === 'webview')!;

    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen()),
    )
    .toBe(false);
  await expect
    .poll(() => page.locator('webview').evaluate(element => getComputedStyle(element).position))
    .not.toBe('fixed');
  process.stdout.write(
    'Live page: manual web fullscreen exit and native screen fullscreen verified.\n',
  );
  await page.getByRole('button', { name: '添加视频', exact: true }).click();
  await page.getByLabel('视频链接 / BV 号').fill('https://www.bilibili.com/bangumi/play/ep6613853');
  await page.getByRole('button', { name: '从链接读取视频 / 分集信息' }).click();
  await expect(page.getByLabel('视频标题', { exact: true })).not.toHaveValue('', {
    timeout: 20000,
  });
  process.stdout.write(
    `Resolved: ${await page.getByLabel('视频标题', { exact: true }).inputValue()} / ${await page.getByLabel('分 P / 分集名称', { exact: true }).inputValue()}\n`,
  );
  await mkdir(join(root, 'test-results'), { recursive: true });
  await page.getByRole('button', { name: '关闭对话框' }).click();
  await page.screenshot({ path: join(root, 'test-results/live-episode.png') });
} finally {
  await app.close();
  await rm(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(
    () => {},
  );
}
