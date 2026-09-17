# 王语晨 · 补档站

基于 [48tools](https://github.com/duan602728596/48tools) 逆向的口袋48 接口，自动抓取 **王语晨（GNZ48 TEAM NIII · 十三期生）** 的：

- 💬 **口袋发言**（口袋48 房间消息：文字 / 图片 / 语音 / 视频 / 直播推送 / 礼物等）
- 📺 **直播 / 录播**（个人口袋直播，支持站点内直接播放回放）
- 🎭 **公演**（**只抓王语晨所在 TEAM NIII 的公演**，按队伍过滤；支持站点内直接播放回放）

数据抓取与展示分离：抓取脚本把数据写成 JSON，静态站点负责展示，可一键部署为补档站。

---

## 目录结构

```
wangyuchen-archive/
├── scraper/                # 抓取脚本（Node.js，零第三方依赖）
│   ├── lib/
│   │   ├── config.mjs      # 王语晨身份参数 + token 读取
│   │   ├── api.mjs         # 口袋48 API 客户端（含 pa 签名）
│   │   ├── pa.mjs          # 用 wasm 生成 pa 反爬签名头
│   │   ├── pa.wasm         # 签名用的 wasm（来自 48tools）
│   │   └── rust-wasm.js    # wasm 加载器（来自 48tools）
│   ├── scrape.mjs          # 抓取主程序（列表 + 按队伍过滤 + 补充播放地址）
│   ├── enrich.mjs          # 一次性补数据：按队伍过滤公演 + 补充每条播放地址
│   ├── package.json
│   └── .env.example
├── scripts/
│   └── setup-vps.sh        # 国内 VPS 一键部署（装 cron 自动抓取）
├── site/                   # 补档站（纯静态，可直接部署）
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   └── data/               # 抓取产物（messages / live / performances / meta）
└── serve.mjs               # 本地静态服务器（零依赖）
```

---

## 一、抓取数据

### 1. 准备环境
- 需要 **Node.js ≥ 18**（已用 Node 22 验证）。
- 无需 `npm install`：脚本只使用 Node 内置模块 + 本地 wasm。

### 2. 获取口袋48 token（仅口袋发言需要）

直播 / 公演 接口**不需要登录**；但**口袋发言**需要你的口袋48 登录 token（且请求要带 `pa` 签名，脚本已自动用 wasm 生成）。

获取 token 的常见方式（任选其一）：
- **方式 A（推荐）**：用 [48tools](https://github.com/duan602728596/48tools) 桌面端登录后，其本地存储里保存了 token；或从口袋48 App 的网络请求中抓取 `token` 请求头（抓包工具如 Charles / mitmproxy，对 `pocketapi.48.cn` 的 HTTPS 请求）。
- **方式 B**：在已登录口袋48 的网页/App 环境里，从 `localStorage` 或请求头复制 `token` 字段值。

> ⚠️ token 等同于你的登录凭证，请勿外泄，也不要提交到公开仓库。

### 3. 运行抓取

```bash
cd scraper
cp .env.example .env        # 编辑 .env，填入 POCKET48_TOKEN=你的token
export POCKET48_TOKEN=你的token   # 或者直接环境变量传入

node scrape.mjs
```

输出写入 `../site/data/`：
- `messages.json` —— 口袋发言（按 msgIdServer 去重，可多次运行增量补档）
- `live.json` —— 直播 / 录播
- `performances.json` —— 公演
- `meta.json` —— 成员信息、统计、更新时间

> 不填 token 也能跑：直播 / 公演 正常抓取，口袋发言会跳过并提示。

### 4. 关于「公演只抓她参加的」与「视频播放」

- **公演按队伍过滤**：王语晨属于 **GNZ48 TEAM NIII**。脚本在抓取 `getOpenLiveList`（GNZ48 全部剧场公演）后，会按 `teamList` 含 `TEAM NIII` 过滤，最终只保留她参加的公演（约 380+ 场），不会混入 TEAM G / Z 等其他队伍。
- **视频播放地址**：口袋48 的列表接口不含视频地址，需对每个 `liveId` 再调一次详情接口拿 m3u8 播放流：
  - 直播：`POST /live/api/v1/live/getLiveOne` → `content.playStreamPath`
  - 公演：`POST /live/api/v1/live/getOpenLiveOne` → `content.playStreams[].streamPath`（取「高清」）
  - 抓到的地址写入每条记录的 `playUrl` 字段；站点用 **hls.js** 直接播放（视频 CDN `idol-vod.48.cn` / `perform-vod.48.cn` 全球可直连且带 `Access-Control-Allow-Origin: *`，**境外浏览器也能直接看**）。

> 若你已有旧数据（`live.json` / `performances.json` 还没带 `playUrl` 或含其他队伍），可跑一次 `node enrich.mjs` 复用现有记录、只补播放地址 + 按队伍过滤，避免重新抓取整个列表。

---

## 二、预览 / 部署补档站

### 本地预览
```bash
node serve.mjs
# 浏览器打开 http://localhost:5173
```

### 部署为静态站
`site/` 是纯静态站点，**直接把 `site/` 目录整体上传**到任意静态托管（GitHub Pages / Vercel / Netlify / 对象存储 / 宝塔）即可。
注意：`site/data/` 要一起上传，站点通过相对路径 `./data/*.json` 读取数据。

---

## 三、放在国内自动运行（重要）

口袋48 接口对**境外 IP 返回 403**，所以抓取必须在「出口为大陆 IP」的环境运行。你有两个落地方式：

### 路① 国内 VPS（最稳，推荐）
在任意**国内节点**云服务器（阿里云 / 腾讯云轻量 / 华为云等）上：
```bash
# 把整个 wangyuchen-archive 目录上传到服务器后，进入目录执行：
bash scripts/setup-vps.sh
# 按提示编辑 scraper/.env 填入 POCKET48_TOKEN，脚本会：
#   - 先试运行一次验证能抓到数据
#   - 写入 crontab：每 4 小时自动 node scrape.mjs，日志在 scraper/cron.log
```
数据自动落到 `site/data/`，再把 `site/` 整体托管（nginx / 对象存储 / CDN）即可对外访问。

### 路② 境外本机 + 国内代理（最省）
你人在境外，但有国内代理出口时，在 `scraper/.env` 加一行：
```bash
SCRAPE_PROXY=https://用户名:密码@代理地址:8443
```
然后直接运行（脚本**内建 CONNECT 隧道代理，无需任何第三方依赖**）：
```bash
cd scraper && node scrape.mjs   # 请求会经代理出口发出
```
> 支持 `http://` / `https://` 代理（含 Basic 认证）。实测某「日本中转回国」的 **Squid HTTPS 代理**（`:8443`）出口为杭州阿里云，可正常访问口袋48。若用 WorkBuddy 自动化任务，同样会在运行时读取 `.env`，自动走代理。

### 关于当前 WorkBuddy 自动化
项目已创建「王语晨补档站自动抓取」定时任务（每 4 小时）。但**本云端沙箱出口在香港，运行仍是 403**——它只会安全地保留你已有的数据、不写空文件。只有当 WorkBuddy 运行在**国内网络**时，这个自动化才会真正抓到数据。否则请用上面的 VPS / 代理方案。

---

## 四、技术说明

- 接口根地址 `https://pocketapi.48.cn`，请求头需带 `appInfo`（设备信息）、`User-Agent`、`Accept-Language`；带 token 的请求额外带 `pa`（wasm 生成的反爬签名）。
- 关键接口（均来自 48tools 逆向）：
  - 口袋发言：`POST /im/api/v1/team/message/list/homeowner` `{ channelId, serverId, nextTime, limit }`
  - 直播列表：`POST /live/api/v1/live/getLiveList` `{ debug, next, groupId, userId, record }`
  - 公演列表：`POST /live/api/v1/live/getOpenLiveList` `{ debug, groupId, next, record }`（结果按 `teamList` 含 TEAM NIII 过滤）
  - 直播播放地址：`POST /live/api/v1/live/getLiveOne` `{ liveId }` → `content.playStreamPath`
  - 公演播放地址：`POST /live/api/v1/live/getOpenLiveOne` `{ liveId }` → `content.playStreams[].streamPath`
- 王语晨固定参数（已核对）：`groupId=12`(GNZ48)、`serverId=2278592`、`channelId=2541547`、`userId=89653517`、`liveRoomId=2466022879`。成员目录来自 48tools 维护的 `roomId.json`。

> 📍 **网络提示**：口袋48 接口对境外 IP 有限制（返回 403）。请在国内网络环境下运行抓取脚本。站点本身是纯静态，部署后任意地区都能访问。

---

## 五、免责声明

本项目数据均逆向自公开的 48tools 项目，仅用于**个人补档与学习研究**。请遵守口袋48 用户协议，勿将抓取的数据用于商业用途或二次传播。如涉及成员隐私，请妥善处理。
