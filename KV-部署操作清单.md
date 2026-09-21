# 王语晨补档站 · KV 数据方案部署清单

## 这次改了什么（为什么不再「一直部署」）
- **数据不再进 git、不再触发站点部署**。抓取（GitHub Actions）跑完后，由 `scripts/sync-kv.mjs` 直接把数据写进 **Cloudflare KV**；前端改从 Worker 的数据 API（`/api/index`、`/api/month`、`/api/live`…）读取。
- 好处：① **站点零部署更新**——只有改页面代码才部署；② **数据无限增长**——口袋发言按「月」分键（`msg/YYYY-MM`），单月远小于 KV 单值 25MB 上限，存多少年都不怕；③ **实时秒更**——写进 KV 浏览器立即能读到。

## 你需要做的（按顺序）

### 1. 创建 KV 命名空间（Cloudflare 控制台）
- 进 Cloudflare 控制台 → **Workers & Pages** → 左侧 **KV**（或「存储与数据库 → KV」）。
- 点 **Create a namespace**，名称填 `wyc-archive-data`。
- 创建后复制它的 **Namespace ID**（一长串十六进制）。
- 打开项目里的 `wrangler.jsonc`，把 `"id": "REPLACE_WITH_YOUR_DATA_KV_ID"` 换成这个 ID。

### 2. 设 SYNC_TOKEN（Cloudflare 控制台）
- 仍在 KV 页面，打开已有的 **SECRETS** 命名空间（就是存 `GH_TOKEN` 那个）。
- 加一个键：**SYNC_TOKEN** = 一段随机串（随便一段 32 位字符，例如 `openssl rand -hex 16` 生成的）。**记下来**。

### 3. 设 GitHub Secret（给 Actions 调接口用）
- 进 GitHub 仓库 `winccctan/wangyuchen-archive` → **Settings → Secrets and variables → Actions → New repository secret**。
- 名称 `SYNC_TOKEN`，值 = 第 2 步那个随机串（**必须两边一致**）。
- （可选）`WORKER_URL` = `https://idol.wyc0518.cc`（不填也行，代码有默认值）。

### 4. 改 Cloudflare 构建命令（关键一步）
- Cloudflare 控制台 → Workers & Pages → `wangyuchen-archive` → **Settings → Build**（或「部署」设置）。
- 把 **Build command** 改为：`npm run build && wrangler deploy`
  （原来大概率是 `wrangler deploy`；加上 `npm run build` 才能在每次部署时用最新的 `site/` 代码生成 `dist/`，而数据不再进 `dist/`、不再触发部署）。
- 确认部署分支是 `main`。

### 5. 推送并部署
- 把改动 push 到 `main`：`worker/index.js`、`site/js/app.js`、`wrangler.jsonc`、`scripts/sync-kv.mjs`、`.github/workflows/scrape.yml`、`package.json`。
- Cloudflare 会自动执行 `npm run build && wrangler deploy`。

### 6. 回填历史数据（一次性）
- 部署完成后，到 GitHub → **Actions → 抓取并同步到 KV → Run workflow**（手动触发一次）。
- scrape 会读仓库里已有的历史 `messages.json`（已到 2026-09-21）+ 抓最新，再由 `sync-kv.mjs` 把全部历史按月写进 KV。
- 等几分钟，打开站点，数据应全部在（首屏秒更 + 下滑「加载更早」拉历史月）。
- 之后每 3 分钟自动抓取、自动写 KV，**不再部署**。

## 验证
- 浏览器开 https://idol.wyc0518.cc/ ，看是否正常加载；点「加载更早」是否拉到更早月份。
- 若空白：检查 Cloudflare KV 是否已绑定、SYNC_TOKEN 两边是否一致、是否已手动触发一次回填（第 6 步）。

## 回滚
- 前端 `app.js` 保留了静态兜底（读 `dist/data/archive.js`）。只要 `dist/` 没被删，旧数据仍在。
- 若 KV 方案出问题，把 `.github/workflows/scrape.yml` 恢复成「提交 git」的旧版本即可退回原架构。
