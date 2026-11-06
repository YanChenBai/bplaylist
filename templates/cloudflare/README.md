# BPlaylist 云端同步

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YanChenBai/bplaylist/tree/main/templates/cloudflare)

点击按钮，将同步服务部署到自己的 Cloudflare 账号。设置 `SYNC_TOKEN` 为至少 32 位随机令牌，保留预填的部署命令；部署流程会创建 D1 数据库并执行迁移。随后在 BPlaylist 的云端同步设置中填写 Worker 地址和相同令牌。

本目录可以独立安装和部署，`worker.js` 已包含运行所需的依赖。源码位于 [BPlaylist 仓库](https://github.com/YanChenBai/bplaylist) 的 `apps/sync` 和 `packages/shared`；在原仓库运行 `vp run build:cloudflare-template` 更新本目录中的生成文件。请在源码中修改服务逻辑。

命令行部署时，先执行 `npm install`，创建自己的 D1 数据库并将 ID 写入 `wrangler.jsonc`，然后设置令牌并部署：

```sh
npx wrangler secret put SYNC_TOKEN
npm run deploy
```
