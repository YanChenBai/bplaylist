import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const userData = await mkdtemp(join(tmpdir(), 'bplaylist-fullscreen-'));
const env: Record<string, string> = { ...process.env, BPLAYLIST_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;

const fixture = `<!doctype html><html><body style="margin:0;background:#141414;color:#ddd">
<div class="bpx-player-container" style="height:100vh"><video></video></div>
<script>
window.__INITIAL_STATE__={videoData:{bvid:'BV1GJ411x7h7',title:'Fullscreen fixture',pages:[{page:1,part:'P1'},{page:2,part:'P2'}]}};
const player=document.querySelector('.bpx-player-container');
const video=document.querySelector('video');
Object.defineProperties(video,{readyState:{get:()=>4},duration:{get:()=>100}});
window.webClicks=0;
setTimeout(()=>{const button=document.createElement('button');button.className='bpx-player-ctrl-web';button.textContent='网页全屏';button.onclick=()=>{window.webClicks++;player.classList.toggle('bpx-state-web');history.replaceState({},'',location.pathname+location.search+'&fullscreen_change='+window.webClicks)};player.append(button)},2000);
</script></body></html>`;

const app = await electron.launch({
  executablePath: process.env.BPLAYLIST_EXECUTABLE ?? require('electron'),
  args: process.env.BPLAYLIST_EXECUTABLE ? [] : [join(root, 'apps/desktop')],
  env,
});

async function readGuest(script: string) {
  return app.evaluate(({ webContents }, script) => {
    const guest = webContents
      .getAllWebContents()
      .find(contents => contents.getType() === 'webview')!;

    return guest.executeJavaScript(script, true);
  }, script);
}

async function pressEscape() {
  await app.evaluate(({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find(contents => contents.getType() === 'webview')!;

    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
}

// Playwright injects renderer input without moving the OS cursor used by the fallback.
async function setNativePointer(x: number, y: number) {
  await app.evaluate(
    ({ BrowserWindow, screen }, { x, y }) => {
      const bounds = BrowserWindow.getAllWindows()[0]!.getContentBounds();
      screen.getCursorScreenPoint = () => ({ x: bounds.x + x, y: bounds.y + y });
    },
    { x, y },
  );
}

try {
  const page = await app.firstWindow();
  await page.getByRole('main', { name: 'BPlaylist 工作区', exact: true }).waitFor();
  await app.evaluate(async ({ session, webContents }, fixture) => {
    session
      .fromPartition('persist:bilibili')
      .protocol.handle(
        'https',
        () => new Response(fixture, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      );

    const guest = webContents
      .getAllWebContents()
      .find(contents => contents.getType() === 'webview')!;

    await guest.loadURL('https://www.bilibili.com/video/BV1GJ411x7h7?p=1');
  }, fixture);
  await expect
    .poll(() => readGuest('Boolean(window.__bplaylist?.read().webFullscreen)'))
    .toBe(true);
  await readGuest("document.querySelector('button').click()");
  await page.waitForTimeout(1500);

  const manualExit = await readGuest(
    '({ clicks: window.webClicks, web: window.__bplaylist.read().webFullscreen })',
  );

  process.stdout.write(
    `After manual exit and same-video URL update: ${JSON.stringify(manualExit)}\n`,
  );

  await readGuest("document.querySelector('.bpx-player-container').requestFullscreen()");
  await expect
    .poll(() => page.locator('webview').evaluate(element => getComputedStyle(element).position))
    .toBe('fixed');

  const screenState = await app.evaluate(async ({ BrowserWindow, webContents }) => {
    const window = BrowserWindow.getAllWindows()[0]!;

    const guest = webContents
      .getAllWebContents()
      .find(contents => contents.getType() === 'webview')!;

    return {
      windowFullscreen: window.isFullScreen(),
      guestFullscreen: await guest.executeJavaScript('Boolean(document.fullscreenElement)'),
    };
  });

  process.stdout.write(`Screen fullscreen: ${JSON.stringify(screenState)}\n`);

  const layout = await page.evaluate(() => {
    const bounds = document.querySelector('webview')!.getBoundingClientRect();
    return {
      width: innerWidth,
      height: innerHeight,
      guest: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      fullscreen: document.fullscreenElement?.tagName,
    };
  });

  process.stdout.write(`Screen fullscreen layout: ${JSON.stringify(layout)}\n`);
  assert.equal(manualExit.web, false);
  assert.equal(manualExit.clicks, 2);
  assert.equal(screenState.guestFullscreen, true);
  assert.equal(screenState.windowFullscreen, true);
  assert.equal(layout.guest.x, 0);
  assert.equal(layout.guest.y, 0);
  assert.ok(Math.abs(layout.guest.width - layout.width) < 1);
  assert.ok(Math.abs(layout.guest.height - layout.height) < 1);

  await readGuest("history.pushState({}, '', '?p=2')");
  await page.waitForTimeout(1000);
  assert.equal(await readGuest('window.webClicks'), 2);
  assert.equal(await readGuest('Boolean(document.fullscreenElement)'), true);

  await pressEscape();
  await expect.poll(() => readGuest('Boolean(document.fullscreenElement)')).toBe(false);
  await expect
    .poll(() => page.locator('webview').evaluate(element => getComputedStyle(element).position))
    .not.toBe('fixed');

  await page.getByRole('button', { name: '进入沉浸模式', exact: true }).click();
  await setNativePointer(200, 200);
  await page.mouse.move(200, 200);
  await expect(page.locator('main > header')).toBeHidden();
  const width = await page.evaluate(() => innerWidth);

  for (const x of [2, width / 2, width - 2]) {
    // Reveal through the main-process fallback, without a renderer pointer event.
    await setNativePointer(x, 1);
    await expect(page.locator('main > header')).toBeVisible();

    for (const y of [18, 45, 53, 20, 1]) {
      await setNativePointer(x, y);
      await page.waitForTimeout(350);
      await expect(page.locator('main > header')).toBeVisible();
    }

    await setNativePointer(x, 120);
    await expect(page.locator('main > header')).toBeHidden();
  }

  await readGuest("document.querySelector('.bpx-player-container').requestFullscreen()");
  await expect.poll(() => readGuest('Boolean(document.fullscreenElement)')).toBe(true);
  await pressEscape();
  await expect.poll(() => readGuest('Boolean(document.fullscreenElement)')).toBe(false);
  await expect(page.locator('main > header')).toBeHidden();
  await pressEscape();
  await expect(page.locator('main > header')).toBeVisible();
  await readGuest("history.pushState({}, '', '?p=1')");
  await expect.poll(() => readGuest('window.__bplaylist.read().webFullscreen')).toBe(true);
  process.stdout.write(
    'Fullscreen smoke passed: manual exit, URL changes, screen fullscreen layout, immersive header edges, immersive Escape, and episode switch.\n',
  );
} finally {
  await app.close();
  await rm(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
