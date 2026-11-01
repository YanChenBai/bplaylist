import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, chromium, expect } from '@playwright/test';
import type { BrowserContext, ElectronApplication } from '@playwright/test';

import { openLibrary } from '../apps/desktop/src/main/storage/database.ts';
import { bridgeConnectionSchema } from '../packages/shared/src/bridge.ts';
import { createPlaylist, videoUrl } from '../packages/shared/src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const userData = await mkdtemp(join(tmpdir(), 'bplaylist-bridge-'));
const browserData = await mkdtemp(join(tmpdir(), 'bplaylist-extension-'));
const artifacts = join(root, 'test-results');
await mkdir(artifacts, { recursive: true });
const url = videoUrl('BV1GJ411x7h7');
const current = createPlaylist('插件验证');
current.nodes = [
  {
    id: 'keep',
    parentId: null,
    kind: 'video',
    alias: '',
    partTitle: 'P1',
    title: '原有条目',
    url,
    start: 0,
    end: null,
  },
  { id: 'group', parentId: null, kind: 'group', title: '活动分组' },
];
current.activeItemId = 'keep';
current.progress.keep = {
  position: 42,
  duration: 3600,
  completed: false,
  updatedAt: new Date().toISOString(),
};
const archive = createPlaylist('归档列表');
const library = openLibrary(join(userData, 'bplaylist.sqlite'));
library.save(current);
library.save(archive);
library.setSetting('activePlaylist', current.id);
library.close();

function readDocument(id: string) {
  const db = openLibrary(join(userData, 'bplaylist.sqlite'));

  try {
    return db.list().find(item => item.id === id)!;
  } finally {
    db.close();
  }
}

const fixture = `<!doctype html><html><head><meta charset="UTF-8"><style>html{font-size:20px}body{margin:0;background:#eee;font:16px sans-serif}.video-toolbar-left{display:flex;align-items:center;margin:30px;gap:16px}button{font-size:16px}video{width:70vw;height:50vh;background:#222}</style></head><body>
<h1>浏览器插件集成验证</h1><video></video><div class="video-toolbar-left"><div class="video-toolbar-left-item"><button class="video-toolbar-share">分享</button><span>936</span></div></div>
<script>
const video=document.querySelector('video');Object.defineProperties(video,{currentTime:{get:()=>1080},duration:{get:()=>3600},readyState:{get:()=>4}});
const originalFetch=window.fetch.bind(window);window.fetch=(input,options)=>String(input).startsWith('https://api.bilibili.com/')?Promise.resolve(new Response(JSON.stringify({code:0,data:{bvid:'BV1GJ411x7h7',title:'活动录播',pages:[{page:1,part:'开场'},{page:2,part:'活动结束'}]}}),{headers:{'content-type':'application/json'}})):originalFetch(input,options);
</script></body></html>`;

let app: ElectronApplication | undefined;
let context: BrowserContext | undefined;
const errors: string[] = [];

try {
  const env: Record<string, string> = {
    ...process.env,
    BPLAYLIST_USER_DATA: userData,
    BPLAYLIST_BRIDGE_PORT: String(randomInt(20000, 45000)),
  };

  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.BPLAYLIST_EXECUTABLE ?? require('electron'),
    args: process.env.BPLAYLIST_EXECUTABLE ? [] : [join(root, 'apps/desktop')],
    env,
  });
  const desktop = await app.firstWindow();
  desktop.on('pageerror', error => errors.push(error.message));
  await desktop.getByRole('main', { name: 'BPlaylist 工作区', exact: true }).waitFor();
  await app.evaluate(
    async ({ session, webContents }, { fixture, url }) => {
      session
        .fromPartition('persist:bilibili')
        .protocol.handle(
          'https',
          () => new Response(fixture, { headers: { 'content-type': 'text/html' } }),
        );

      const guest = webContents
        .getAllWebContents()
        .find(contents => contents.getType() === 'webview')!;

      await guest.loadURL(url);
    },
    { fixture, url },
  );
  const addressInput = desktop.getByRole('textbox', { name: 'B 站网址' });
  const addressForm = desktop.locator('main > header > form');
  const shortWidth = (await addressForm.boundingBox())!.width;
  await addressInput.focus();
  await expect
    .poll(async () => (await addressForm.boundingBox())!.width)
    .toBeGreaterThan(shortWidth + 100);
  await addressInput.evaluate(element => element.blur());
  await expect
    .poll(async () => Math.abs((await addressForm.boundingBox())!.width - shortWidth))
    .toBeLessThan(1);
  await desktop.getByRole('button', { name: '切换白色主题' }).click();
  await expect(desktop.locator('html')).toHaveAttribute('data-theme', 'light');
  await desktop.getByRole('button', { name: '连接浏览器插件' }).click();
  await desktop.getByRole('button', { name: '复制连接信息' }).click();
  await expect(desktop.getByText('连接信息已复制', { exact: true })).toBeVisible();

  const connection = bridgeConnectionSchema.parse(
    JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText())),
  );

  await desktop.getByRole('button', { name: '关闭对话框' }).click();
  await expect(desktop.getByRole('dialog')).toHaveCount(0);
  const playlistSelect = desktop.getByRole('combobox', { name: '切换播放列表' });
  await playlistSelect.click();
  await expect(desktop.getByRole('listbox', { name: '切换播放列表' })).toBeVisible();
  await desktop.getByRole('option', { name: archive.title, exact: true }).click();
  await expect(playlistSelect).toContainText(archive.title);
  await expect(playlistSelect).toBeEnabled();
  await playlistSelect.click();
  await desktop.getByRole('option', { name: current.title, exact: true }).click();
  await expect(playlistSelect).toContainText(current.title);
  const extensionPath = join(root, 'apps/extension/.output/chrome-mv3');
  context = await chromium.launchPersistentContext(browserData, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await context.route('https://www.bilibili.com/**', route =>
    route.fulfill({ body: fixture, contentType: 'text/html' }),
  );
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const add = page.getByRole('button', { name: '添加到 BPlaylist', exact: true });
  const shareBounds = await page.locator('.video-toolbar-left-item').boundingBox();
  const addBounds = await add.boundingBox();
  assert.ok(shareBounds && addBounds);
  assert.ok(addBounds.x >= shareBounds.x + shareBounds.width);
  assert.ok(
    Math.abs(addBounds.y + addBounds.height / 2 - shareBounds.y - shareBounds.height / 2) < 2,
  );
  await add.click();
  await expect(page.getByRole('status').filter({ hasText: '尚未连接桌面端' })).toBeVisible();
  await page.getByRole('button', { name: '关闭对话框' }).click();

  const popup = await context.newPage();
  popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByLabel('粘贴连接信息').fill(JSON.stringify(connection));
  await popup.getByRole('button', { name: '保存并连接' }).click();
  await expect(popup.getByRole('button', { name: '保存并连接' })).toBeEnabled();

  if (!(await popup.getByRole('status').textContent())?.includes('已连接')) {
    throw new Error(
      `连接失败: ${(await popup.locator('[data-sonner-toast]').allTextContents()).join(' ')}`,
    );
  }

  await popup.getByRole('button', { name: '切换白色主题' }).click();
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.bringToFront();
  await add.click();
  await expect(page.getByLabel('视频标题', { exact: true })).toHaveValue('活动录播');
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('18:00');
  await page.getByLabel('别名（可选）').fill('跨集活动');
  await page.getByLabel('跨分 P / 分集播放').check();
  await page.getByRole('combobox', { name: '结束分 P / 分集' }).click();
  await page.getByRole('option', { name: 'P2 · 活动结束' }).click();
  await page.getByLabel('结束时间（留空播到结尾）').fill('36:00');
  await page.getByRole('combobox', { name: '所属分组' }).click();
  await page.getByRole('option', { name: '活动分组' }).click();
  await page.screenshot({ path: join(artifacts, 'extension-light.png') });
  const dialog = page.getByRole('dialog', { name: '添加视频' });
  assert.equal(
    await dialog.evaluate(element => getComputedStyle(element).backgroundColor),
    'rgb(255, 255, 255)',
  );
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      readDocument(current.id).nodes.find(
        node => node.kind === 'video' && node.alias === '跨集活动',
      ),
    )
    .toMatchObject({
      parentId: 'group',
      start: 1080,
      end: 2160,
      continuation: [{ title: 'P2 · 活动结束', url: videoUrl('BV1GJ411x7h7', 2) }],
    });
  await expect(desktop.getByText('跨集活动', { exact: true })).toBeVisible();
  assert.equal(readDocument(current.id).activeItemId, 'keep');
  assert.equal(readDocument(current.id).progress.keep.position, 42);
  await desktop.screenshot({ path: join(artifacts, 'desktop-light.png') });
  await popup.getByRole('button', { name: '切换黑色主题' }).click();
  await page.bringToFront();
  await add.click();
  await page.getByRole('combobox', { name: '添加到播放列表' }).click();
  await page.getByRole('option', { name: archive.title, exact: true }).click();
  await page.screenshot({ path: join(artifacts, 'extension-dark.png') });
  await page.getByRole('button', { name: '全部分集', exact: true }).click();
  await expect.poll(() => readDocument(archive.id).nodes.length).toBe(3);
  assert.equal(readDocument(archive.id).nodes.filter(node => node.kind === 'group').length, 1);
  await expect(desktop.getByRole('combobox', { name: '切换播放列表' })).toContainText(
    current.title,
  );
  await page.evaluate(() => {
    history.pushState({}, '', '?p=2');
    document.querySelector('.video-toolbar-left')!.innerHTML =
      '<div class="video-toolbar-left-item"><button class="video-toolbar-share">分享</button><span>936</span></div>';
  });
  await expect(add).toHaveCount(1);
  await add.click();
  await expect(page.getByRole('combobox', { name: '当前视频的分 P / 分集' })).toContainText('P2');
  await page.getByRole('button', { name: '关闭对话框' }).click();
  await app.close();
  app = undefined;
  await add.click();
  await expect(page.getByRole('status').filter({ hasText: '无法连接桌面端' })).toBeVisible();
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Extension smoke passed: pairing, Shadow DOM, themes, cross-part append, live desktop update, inactive target, SPA remount, offline feedback.\n',
  );
} finally {
  await context?.close();
  await app?.close();
  await rm(userData, { recursive: true, force: true });
  await rm(browserData, { recursive: true, force: true });
}
