import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { ElectronApplication } from '@playwright/test';
import { _electron as electron, expect } from '@playwright/test';

import { playlistSchema } from '../packages/shared/src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/desktop/package.json'));

const userData = await mkdtemp(join(tmpdir(), 'bplaylist-smoke-'));
const artifacts = join(root, 'test-results');
await mkdir(artifacts, { recursive: true });
const url = 'https://www.bilibili.com/video/BV1GJ411x7h7?p=1';

const item = (id: string, parentId: string | null, start: number, end: number) => ({
  id,
  parentId,
  kind: 'video',
  title: `测试片段 ${id}`,
  url,
  start,
  end,
});

const playlist = {
  version: 1,
  id: 'smoke',
  title: '播放验证',
  activeItemId: null,
  progress: {},
  updatedAt: new Date().toISOString(),
  nodes: [
    item('A', null, 10, 20),
    { id: 'group', parentId: null, kind: 'group', title: '测试分组' },
    item('B', 'group', 30, 40),
    item('C', null, 50, 60),
  ],
};

const database = new DatabaseSync(join(userData, 'bplaylist.sqlite'));
database.exec('CREATE TABLE playlists (id TEXT PRIMARY KEY NOT NULL, document TEXT NOT NULL)');
database.prepare('INSERT INTO playlists VALUES (?, ?)').run(playlist.id, JSON.stringify(playlist));
database.close();

// 确定性的页面夹具；实际执行构建产物里的注入脚本、oRPC 和 SQLite。
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#181818;color:#ddd;font:14px sans-serif}.bpx-player-container{margin:30px;background:#080808;height:70vh;display:grid;place-items:center}.bpx-state-web{position:fixed;inset:0;margin:0;height:100vh}button{padding:10px}video{width:0;height:0}
</style></head><body><h1>测试播放器</h1><div class="bpx-player-container"><div><p>播放器适配器 · Electron 集成验证</p><button class="bpx-player-ctrl-web">网页全屏</button><video></video></div></div><script>
window.__INITIAL_STATE__={videoData:{bvid:'BV1GJ411x7h7',title:'测试播放器',pages:[{page:1,part:'第一集'},{page:2,part:'第二集'}]}};
const video=document.querySelector('video');let position=0,paused=true,ended=false;
Object.defineProperties(video,{currentTime:{get:()=>position,set:value=>{position=value;ended=false;video.dispatchEvent(new Event('seeked'))}},duration:{get:()=>100},readyState:{get:()=>4},paused:{get:()=>paused},ended:{get:()=>ended}});
video.play=async()=>{paused=false;video.dispatchEvent(new Event('play'))};video.pause=()=>{paused=true;video.dispatchEvent(new Event('pause'))};
window.setTime=value=>{position=value;video.dispatchEvent(new Event('timeupdate'))};
window.endVideo=()=>{position=100;ended=true;video.dispatchEvent(new Event('ended'))};
document.querySelector('button').onclick=()=>document.querySelector('.bpx-player-container').classList.toggle('bpx-state-web');
</script></body></html>`;

const errors: string[] = [];
let app: ElectronApplication | undefined;

async function launch() {
  const env: Record<string, string> = { ...process.env, BPLAYLIST_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;

  const instance = await electron.launch({
    executablePath: process.env.BPLAYLIST_EXECUTABLE ?? require('electron'),
    args: process.env.BPLAYLIST_EXECUTABLE ? [] : [join(root, 'apps/desktop')],
    env,
  });

  const page = await instance.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('main', { name: 'BPlaylist 工作区', exact: true }).waitFor();
  await instance.evaluate(
    async ({ session, webContents }, { fixture, url }) => {
      const partition = session.fromPartition('persist:bilibili');
      partition.protocol.handle(
        'https',
        () => new Response(fixture, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      );

      const guest = webContents
        .getAllWebContents()
        .find(contents => contents.getType() === 'webview')!;

      await guest.loadURL(url);
    },
    { fixture, url },
  );
  return { instance, page };
}

async function guestRead(script: string) {
  assert.ok(app);
  return app.evaluate(async ({ webContents }, script) => {
    const guest = webContents
      .getAllWebContents()
      .find(contents => contents.getType() === 'webview')!;

    return guest.executeJavaScript(script, true);
  }, script);
}

function readDocument() {
  const db = new DatabaseSync(join(userData, 'bplaylist.sqlite'), { readOnly: true });

  try {
    const row = db.prepare('SELECT document FROM playlists WHERE id = ?').get('smoke');
    assert.equal(typeof row?.document, 'string');
    return playlistSchema.parse(JSON.parse(row!.document as string));
  } finally {
    db.close();
  }
}

try {
  let session = await launch();
  app = session.instance;
  const page = session.page;

  const windowSizing = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const original = window.getBounds();
    const minimum = window.getMinimumSize();
    window.setSize(480, 270);
    const small = window.getSize();
    window.setBounds(original);
    return { original, minimum, small };
  });

  assert.deepEqual(windowSizing.minimum, [0, 0]);
  assert.ok(Math.abs(windowSizing.small[0]! - 480) <= 1);
  assert.ok(Math.abs(windowSizing.small[1]! - 270) <= 1);
  assert.ok(Math.abs(windowSizing.original.width / windowSizing.original.height - 16 / 9) < 0.01);
  await expect(page.getByRole('combobox', { name: '切换播放列表' })).toContainText('播放验证');
  await guestRead(
    `(() => { const link = document.createElement('a'); link.href = 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2'; link.target = '_blank'; document.body.append(link); link.click(); })()`,
  );
  await expect.poll(() => guestRead('location.href')).toContain('?p=2');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await page.getByRole('button', { name: '播放列表设置', exact: true }).click();
  assert.equal(
    await page
      .getByRole('menuitem', { name: '导入播放列表' })
      .evaluate(element => element === document.activeElement),
    false,
  );
  await expect(page.getByRole('menuitem', { name: '导入播放列表' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '导出播放列表' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '重命名播放列表' })).toBeVisible();
  await expect(page.getByRole('menuitemcheckbox', { name: '自动网页全屏' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('menuitemcheckbox', { name: '自动网页全屏' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: '自动网页全屏' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.getByRole('menuitemcheckbox', { name: '自动网页全屏' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: '自动网页全屏' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '进入网页全屏', exact: true })).toHaveCount(0);

  const originalBounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );

  const headerControls = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-header-actions] > button, [data-window-controls] > button',
      ),
    ].map(button => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );

  assert.equal(headerControls.length, 6);

  for (let index = 0; index < headerControls.length; index++) {
    assert.equal(headerControls[index].width, 46);
    assert.equal(headerControls[index].height, 39);
    assert.equal(headerControls[index].y, 1);

    if (index) {
      assert.equal(headerControls[index].x - headerControls[index - 1].x, 46);
    }
  }

  await page.getByRole('button', { name: '进入沉浸模式', exact: true }).click();
  await page.mouse.move(500, 250);
  await expect(page.locator('main > header')).toBeHidden();

  const windowState = await app.evaluate(({ BrowserWindow }) => ({
    fullscreen: BrowserWindow.getAllWindows()[0].isFullScreen(),
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
  }));

  assert.equal(windowState.fullscreen, false);
  assert.deepEqual(windowState.bounds, originalBounds);
  await expect(page.locator('aside')).toHaveCount(0);
  const immersiveBrowser = await page.getByRole('region', { name: 'B 站浏览器' }).boundingBox();
  assert.ok(immersiveBrowser);
  assert.ok(Math.abs(immersiveBrowser.width - (await page.evaluate(() => innerWidth))) < 1);

  await expect(page.locator('aside')).toHaveCount(0);
  await page.screenshot({ path: join(artifacts, 'immersive.png') });
  await page.mouse.move(500, 4);
  await expect(page.getByRole('navigation', { name: '网页导航' })).toBeVisible();
  await expect(page.getByRole('button', { name: '最小化窗口' })).toBeVisible();
  await page.getByRole('button', { name: '展开播放列表', exact: true }).click();
  await expect(page.locator('aside')).toBeVisible();
  await expect
    .poll(async () => (await page.getByRole('region', { name: 'B 站浏览器' }).boundingBox())!.width)
    .toBe(immersiveBrowser.width - 380);
  await page.getByRole('button', { name: '折叠播放列表', exact: true }).click();
  await expect(page.locator('aside')).toHaveCount(0);
  await expect
    .poll(async () => (await page.getByRole('region', { name: 'B 站浏览器' }).boundingBox())!.width)
    .toBe(immersiveBrowser.width);
  await page.getByRole('button', { name: '展开播放列表', exact: true }).click();
  await expect(page.locator('aside')).toBeVisible();
  await expect
    .poll(async () => (await page.getByRole('region', { name: 'B 站浏览器' }).boundingBox())!.width)
    .toBe(immersiveBrowser.width - 380);
  await page.screenshot({ path: join(artifacts, 'immersive-header.png') });
  await page.mouse.move(500, 250);
  await expect(page.locator('main > header')).toBeHidden();
  await app.evaluate(({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find(contents => contents.getType() === 'webview')!;

    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
  await expect(page.getByRole('navigation', { name: '网页导航' })).toBeVisible();
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()),
    originalBounds,
  );
  await page.getByRole('button', { name: '最大化窗口', exact: true }).click();
  await expect
    .poll(() =>
      app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
    )
    .toBe(true);
  await page.getByRole('button', { name: '还原窗口', exact: true }).click();
  await expect
    .poll(() =>
      app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
    )
    .toBe(false);
  await expect(page.getByText('视频与列表进度自动保存', { exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: '切换播放列表' }).click();
  await expect(page.getByRole('listbox', { name: '切换播放列表' })).toBeVisible();
  await page.screenshot({ path: join(artifacts, 'playlist-select.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '播放 测试片段 A', exact: true }).click();
  await expect.poll(() => guestRead('document.querySelector("video").currentTime')).toBe(10);
  await expect
    .poll(() => guestRead('Boolean(document.querySelector(".bpx-state-web"))'))
    .toBe(true);

  const collapsing = await page.evaluate(async () => {
    const panel = document.querySelector('aside')!.parentElement!;
    document.querySelector<HTMLButtonElement>('[aria-label="折叠播放列表"]')!.click();
    const widths = [];

    for (let frame = 0; frame < 6; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      widths.push(panel.getBoundingClientRect().width);
    }

    return { widths, duration: getComputedStyle(panel).transitionDuration };
  });

  assert.ok(
    collapsing.widths.some(width => width > 0 && width < 380),
    JSON.stringify(collapsing),
  );
  await expect(page.getByRole('complementary', { name: '播放列表' })).toHaveCount(0);
  await guestRead('window.setTime(20.1)');
  await expect.poll(() => guestRead('document.querySelector("video").currentTime')).toBe(30);
  await guestRead('window.setTime(40.1)');
  await expect.poll(() => guestRead('document.querySelector("video").currentTime')).toBe(50);
  await page.getByRole('button', { name: '展开播放列表', exact: true }).click();
  await expect.poll(() => readDocument().progress.B?.completed).toBe(true);
  await page.getByRole('button', { name: '添加分组', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect
    .poll(() => page.getByRole('dialog').evaluate(element => element.getAnimations().length))
    .toBe(0);
  await page.getByLabel('名称', { exact: true }).fill('通过 UI 创建的分组');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '通过 UI 创建的分组', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加视频', exact: true }).click();

  const fixedRegions = await page.getByRole('dialog').evaluate(dialog => {
    dialog.style.maxHeight = '500px';
    const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')!;
    const header = dialog.querySelector('header')!;
    const footer = dialog.querySelector<HTMLElement>('[data-dialog-footer]')!;

    const before = {
      header: header.getBoundingClientRect().top,
      footer: footer.getBoundingClientRect().top,
    };

    body.scrollTop = body.scrollHeight;
    return {
      before,
      after: {
        header: header.getBoundingClientRect().top,
        footer: footer.getBoundingClientRect().top,
      },
      bodyScrollable: body.scrollHeight > body.clientHeight,
    };
  });

  assert.deepEqual(fixedRegions.before, fixedRegions.after);
  assert.equal(fixedRegions.bodyScrollable, true);
  await expect(page.getByRole('button', { name: '读取当前视频', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
  await page.getByRole('dialog').evaluate(dialog => dialog.style.removeProperty('max-height'));
  await page.getByLabel('视频标题', { exact: true }).fill('错误样式验证');
  await page.getByLabel('视频链接 / BV 号').fill('BV1GJ411x7h7');
  await page.getByLabel('开始时间', { exact: true }).fill('oops');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const errorToast = page.locator('[data-sonner-toast][data-type="error"]').last();
  await expect(errorToast).toContainText('时间格式应为');
  await expect(errorToast).toHaveCSS('opacity', '1');
  await expect.poll(() => errorToast.evaluate(element => element.getAnimations().length)).toBe(0);
  await expect(errorToast).toBeInViewport({ ratio: 1 });
  assert.equal(
    await errorToast.evaluate(element => getComputedStyle(element).backgroundColor),
    'rgb(27, 27, 27)',
  );
  assert.equal(
    await errorToast.evaluate(element => Boolean(element.closest('dialog[open]'))),
    true,
  );
  await page.screenshot({ path: join(artifacts, 'error-toast.png') });
  await errorToast.getByRole('button', { name: 'Close toast' }).click();
  await page.getByLabel('视频标题', { exact: true }).fill('原始视频标题');
  await page.getByLabel('别名（可选）').fill('UI 新建片段');
  await page.getByLabel('分 P / 分集名称', { exact: true }).fill('P1 · 基础');
  await page
    .getByLabel('视频链接 / BV 号')
    .fill('https://www.bilibili.com/video/BV1GJ411x7h7?p=1&t=1266&share_source=copy_web');
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('21:06');
  await page.getByLabel('开始时间', { exact: true }).fill('00:05');
  await page.getByLabel('结束时间（留空播到结尾）').fill('00:15');
  await page.getByRole('combobox', { name: '所属分组' }).click();
  await page.getByRole('option', { name: '通过 UI 创建的分组', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放 UI 新建片段', exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: '拖拽 UI 新建片段', exact: true })
    .dragTo(page.locator('[data-node-id="A"]'), { targetPosition: { x: 100, y: 42 } });
  await expect
    .poll(
      () =>
        readDocument().nodes.find(node => node.kind === 'video' && node.alias === 'UI 新建片段')
          ?.parentId,
    )
    .toBeNull();
  await page
    .getByRole('button', { name: '播放 UI 新建片段', exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  await page.getByLabel('别名（可选）').fill('UI 修改片段');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放 UI 修改片段', exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: '通过 UI 创建的分组', exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('button', { name: '通过 UI 创建的分组', exact: true })).toHaveCount(
    0,
  );
  await guestRead('window.setTime(55)');
  await expect.poll(async () => guestRead('window.__bplaylist.read().position')).toBe(55);
  await guestRead('document.querySelector("video").pause()');
  await expect.poll(() => readDocument().progress.C?.position, { timeout: 8000 }).toBe(55);
  await page.screenshot({ path: join(artifacts, 'desktop.png') });
  await page.getByRole('button', { name: '折叠播放列表', exact: true }).click();
  await page.screenshot({ path: join(artifacts, 'collapsed.png') });
  await app.close();
  app = undefined;
  session = await launch();
  app = session.instance;
  await session.page.getByRole('button', { name: '展开播放列表', exact: true }).click();
  await expect(
    session.page.getByRole('button', { name: '播放 UI 修改片段', exact: true }),
  ).toBeVisible();
  await session.page.getByRole('button', { name: '播放 测试片段 C', exact: true }).click();

  try {
    await expect.poll(() => guestRead('document.querySelector("video").currentTime')).toBe(55);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        saved: readDocument(),
        url: await guestRead('location.href'),
        errors,
        body: await session.page.locator('body').innerText(),
      })}\n`,
    );
    throw error;
  }

  assert.equal(readDocument().activeItemId, 'C');
  const rangePage = session.page;
  await rangePage.getByRole('button', { name: '添加视频', exact: true }).click();
  await rangePage.getByRole('button', { name: '读取当前视频', exact: true }).click();
  await rangePage.getByLabel('别名（可选）').fill('跨集活动');
  await rangePage.getByLabel('跨分 P / 分集播放', { exact: true }).check();
  await rangePage.getByRole('combobox', { name: '结束分 P / 分集', exact: true }).click();
  await rangePage.getByRole('option', { name: 'P2 · 第二集', exact: true }).click();
  await rangePage.getByLabel('开始时间', { exact: true }).fill('01:20');
  await rangePage.getByLabel('结束时间（留空播到结尾）').fill('00:36');
  await rangePage.screenshot({ path: join(artifacts, 'cross-part-editor.png') });
  await rangePage.getByRole('button', { name: '保存', exact: true }).click();
  await rangePage.getByRole('button', { name: '播放 跨集活动', exact: true }).click();
  await expect.poll(() => guestRead('document.querySelector("video").currentTime')).toBe(80);
  await guestRead('window.endVideo()');
  await expect.poll(() => guestRead('new URL(location.href).searchParams.get("p")')).toBe('2');
  await expect.poll(() => guestRead('document.querySelector("video").paused')).toBe(false);
  await expect.poll(() => guestRead('document.querySelector("video").currentTime')).toBe(0);

  const range = readDocument().nodes.find(
    node => node.kind === 'video' && node.alias === '跨集活动',
  );

  assert.ok(range?.kind === 'video' && range.continuation);
  assert.equal(range.continuation.length, 1);
  await guestRead('window.setTime(36)');
  await expect.poll(() => readDocument().progress[range.id]?.completed).toBe(true);
  assert.equal(readDocument().progress[range.id].segmentIndex, 1);
  await expect.poll(() => guestRead('document.querySelector("video").paused')).toBe(true);
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Electron smoke passed: oRPC, injection, grouped clips, fullscreen, collapse, UI editing, SQLite restart/resume.\n',
  );
} finally {
  await app?.close();
  await rm(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(
    error => {
      process.stderr.write(`临时测试目录未能清理 ${userData}: ${error.message}\n`);
    },
  );
}
