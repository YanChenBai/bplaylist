<p align="center">
  <img src="./docs/assets/logo.svg" width="128" height="128" alt="BPlaylist" />
</p>

<h1 align="center">BPlaylist</h1>

<p align="center">把想看的片段，排成自己的播放列表。</p>

<p align="center">
  <a href="https://github.com/YanChenBai/bplaylist/releases">下载</a> ·
  <a href="#功能">功能</a> ·
  <a href="#开始使用">开始使用</a> ·
  <a href="#开发">开发</a> ·
  <a href="https://github.com/YanChenBai/bplaylist/issues">反馈问题</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-desktop-d6d6d6?style=flat-square&labelColor=171717" alt="Windows desktop" />
  <img src="https://img.shields.io/badge/Vue-3-d6d6d6?style=flat-square&labelColor=171717" alt="Vue 3" />
  <img src="https://img.shields.io/badge/Electron-45-d6d6d6?style=flat-square&labelColor=171717" alt="Electron 45" />
</p>

收藏了一场录播里的几个活动、一套教程里的几节课，或者散落在不同分 P 的精彩片段？把它们放进 BPlaylist，按你安排的顺序接着看。

左边是熟悉的 B 站，右边是你的播放列表。登录、弹幕、清晰度和播放暂停，继续使用 B 站播放器。

## 功能

|                          |                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| **想看哪段，就排哪段**   | 完整视频、分 P、番剧分集，或只取其中的一段时间。支持 BV 号和视频分享链接，自动识别分 P 与空降时间。 |
| **一个活动，跨集连着看** | 从 P1 的 `18:00` 播到 P2 的 `36:00`。中间自动切集，整个范围只占一个播放项。                         |
| **按自己的习惯整理**     | 为条目取别名，用嵌套分组归类，拖拽排序、移入移出分组，右键编辑和删除。组内播完，继续下一项。        |
| **下次，从这里继续**     | 自动保存当前播放项、所在分集、视频时间和完成状态。重新打开后，点击条目继续上次的进度。              |
| **把画面留给视频**       | 自动网页全屏，随时折叠侧栏。沉浸模式隐藏顶部栏，鼠标移到窗口顶部即可找回导航和窗口按钮。            |
| **列表和进度一起带走**   | JSON 导入导出；也可以连接自己的 Cloudflare D1，在不同设备间手动上传、下载列表和进度。               |
| **在浏览器里顺手收录**   | 在 B 站分享按钮旁点击 BPlaylist，自动带入当前分集与播放时间，选择列表和分组后直接添加。             |
| **黑白两种外观**         | 桌面端与浏览器插件都支持黑白主题，自动记住选择。                                                    |

## 开始使用

1. 在左侧打开 B 站并登录，找到想看的视频。
2. 点击侧栏的 **＋**，读取当前视频，或粘贴链接后点击 **读取**。
3. 选择分集、填写时间范围，按需要设置别名和分组，然后保存。
4. 点击播放项，后面的内容会按列表顺序继续播放。切换顶部播放列表只切换浏览内容，原列表继续播放；点击其他列表中的条目后才切换播放。

跨集片段可以这样设置：

```text
开始分集  P1    开始时间  18:00
结束分集  P2    结束时间  36:00

P1 18:00 → P1 结尾 → P2 00:00 → P2 36:00 → 下一项
```

勾选 **跨分 P / 分集播放** 即可选择结束分集。结束时间留空，播放到末集结尾。

列表名称旁的设置菜单提供导入、导出、重命名和自动网页全屏开关。主题切换和浏览器插件连接位于顶部折叠按钮旁。标题栏的四角按钮或 `F11` 进入沉浸模式，`Esc` / `F11` 退出；进入时自动折叠侧栏，移到顶部后可以重新展开。

### 从浏览器添加

1. 执行 `vp run build:extension`。在 Chrome / Edge 的扩展管理中打开开发者模式，加载已解压的扩展，选择 `apps/extension/.output/chrome-mv3/`。
2. 保持桌面端运行，在顶部点击 **连接浏览器插件 → 复制连接信息**。点击浏览器工具栏里的 BPlaylist 图标，粘贴后保存连接。
3. 打开 B 站视频或番剧页面，在分享按钮旁点击 **BPlaylist**。可修改别名、分组和时间范围，也可跨分 P / 分集或一次加入全部分集。

插件与桌面端共用添加表单。插件后台通过本机服务追加条目，桌面端会自动更新当前列表，保留正在播放的内容和进度。连接信息只用于自己的浏览器；桌面端重置密钥后需要重新连接。服务默认只监听 `127.0.0.1:47821`，端口冲突时可通过环境变量 `BPLAYLIST_BRIDGE_PORT` 指定其他端口。

插件图标里的日/月按钮切换插件外观；桌面端在顶部主题按钮中切换。B 站网页使用自己的主题设置。

<details>
<summary>可选：让列表通过 Cloudflare D1 在设备间流转</summary>

远程功能默认关闭。部署自己的 Worker 后，在标题栏的云图标中填写服务地址和令牌。

在 `apps/sync` 中执行：

```sh
vp exec wrangler d1 create bplaylist
```

将数据库 ID 填入 `wrangler.jsonc` 的 `database_id`，然后执行：

```sh
vp exec wrangler d1 migrations apply bplaylist --remote
vp exec wrangler secret put SYNC_TOKEN
vp exec wrangler deploy
```

上传和下载均由你手动发起。列表包含播放进度，服务会检查版本冲突；下载同 ID 列表会替换本地版本，需要保留两份时先导出备份。一个 Worker 和令牌对应一个个人资料库，当前不提供账号系统或自动双向同步。

桌面端使用系统安全存储加密令牌。导出文件不包含令牌和 B 站 Cookie。

</details>

## 开发

安装 [Vite+](https://viteplus.dev/)，克隆项目后启动：

```sh
git clone https://github.com/YanChenBai/bplaylist.git
cd bplaylist
vp install
vp run dev
```

构建 Windows 安装版和便携版：

```sh
vp run package
```

浏览器插件开发使用 `vp run dev:extension`，生成 ZIP 使用 `vp run zip:extension`。

生成的文件位于 `apps/desktop/release/`。Logo 的 SVG 源文件会在开发和构建时自动生成应用图标。

<details>
<summary>检查与测试</summary>

```sh
vp check
vp test run
vp run typecheck
vp run build
vpx scripts/smoke.ts
vpx scripts/fullscreen-smoke.ts
vpx scripts/sync-smoke.ts
vp exec playwright install chromium
vpx scripts/extension-smoke.ts
```

插件集成检查加载真实 Chromium 扩展，并用可控 B 站页面验证连接、跨集添加、桌面更新、主题和离线反馈。桌面集成检查使用可控的播放器页面；云端集成检查使用本地 workerd 和 D1。实际 B 站页面检查需要网络：

```sh
vpx scripts/live-smoke.ts
```

</details>

---

独立的个人播放列表工具，与哔哩哔哩无隶属关系。视频访问和播放能力取决于 B 站页面、账号权限与网络环境。
