// 生成发布目录 dist/：只包含站点运行必需的文件。
// 目的：site/data 里的 messages.json / live.json / performances.json 是完整存档（十几 MB），
// 网页实际只需要已合并好的 archive.js，打包进发布目录会拖慢加载甚至超出部署体积限制。
// 用法：node scripts/build-dist.mjs
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SITE = join(ROOT, 'site');
const DIST = join(ROOT, 'dist');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

function cp(rel) {
  const src = join(SITE, rel);
  const dst = join(DIST, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return statSync(dst).size;
}

// 整目录复制（表情图这类「很多个小文件」的资源，逐个写白名单不现实，也不好维护）
function cpDir(rel) {
  const src = join(SITE, rel);
  const dst = join(DIST, rel);
  let n = 0;
  let bytes = 0;
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(from, e.name), join(to, e.name));
      else if (e.isFile()) {
        copyFileSync(join(from, e.name), join(to, e.name));
        n += 1;
        bytes += statSync(join(to, e.name)).size;
      }
    }
  };
  walk(src, dst);
  return { n, bytes };
}

const files = [
  'index.html',
  'stats.html', // 翻译使用统计（带密码；主站由 Worker 屏蔽该路径，只有 GitHub Pages 备份站能打开）
  'admin-7f2a.html', // 行程后台（隐藏地址 + 密码；不在站内暴露入口，页面 noindex）
  'css/style.css',
  'js/app.js',
  'vendor/hls.min.js',
  'assets/newfan-guide.jpg',
  'assets/gs2024-1.jpg',      // 2024 公式照（微博，蓝格纹礼服）
  'assets/gs2024-2.jpg',
  'assets/gs2024-3.jpg',
  'assets/gs2024-4.jpg',      // 2024 特写
  'assets/gs2025-1.jpg',      // 2025 公式照（微博，白礼服+皇冠）
  'assets/gs2025-2.jpg',      // 2025 特写
  'assets/gs2025-3.jpg',
  'assets/gs2025-4.jpg',
  'assets/member-gs1.jpg',    // 2026 官网公式照 1
  'assets/member-gs2.jpg',    // 2026 官网公式照 2
  'assets/member-gs4.jpg',    // 2026 官网公式照 3
  'assets/avatar.png',        // 头部头像（透明底抠图）
  'assets/avatar-round.png',  // 网站图标 / apple-touch-icon
  'data/meta.json', // 仅 0.5KB：前端用它取数据版本号，决定是否复用缓存的大文件
  'data/archive.js',
  'data/social-media.js', // 社媒美图（小号 @忘记自己是鱼_ 本人媒体帖），前端经 Worker 图片代理取图
  'data/performance-cuts.js', // 公演 cut（微博 7794095795 切片），由 app.js 渲染到「公演cut」子标签
  'data/live-cuts.js', // 直播切片 / 直播回放（B站 忘记自己是猪、Chzhnh 两个号的投稿）
  // —— 以下为 2026-09-23 新增（「我的」档案卡 + 「行程」栏 + 候选功能）——
  'css/demo.css', // 档案卡 / 行程 / 候选功能样式（新 index.html 会加载它）
  'js/schedule.js',           // 行程快照：微博应援会「本周行程」
  'js/theater-schedule.js',   // 行程快照：星梦剧院 NIII / 全团联合安排
  'js/bili-cuts.js',          // 她的公演 cut（B站合集 season 4752040）
  'js/demo-features.js',      // 候选功能：收藏码 / 搜索筛选 / 分享卡 / 随机考古 / 热力图 / 开播提醒
  'assets/member-gs3.jpg',    // 2026 官网公式照（补齐，原先漏了）
  'og.png'                    // 分享卡片（og:image / twitter:image，1200×630，走根目录短链接）
];

// 整目录复制：口袋表情图（105 张 gif，共 ~300KB），逐个列白名单不现实
const dirs = [
  'assets/emoji',
  'cards/photos' // 生写小卡图鉴实物照（17 张 ~5.7MB，「生写小卡」子标签用）
];

let total = 0;
for (const f of files) {
  const size = cp(f);
  total += size;
  console.log(`  ${f.padEnd(22)} ${(size / 1024).toFixed(1)} KB`);
}

// 给静态资源加版本号查询串，避免浏览器/CDN 缓存住旧文件导致页面“点了没内容”。
// 只在 dist/（HTTP 部署）上加；site/ 需支持 file:// 直接打开，file:// 下带查询串会取不到文件。
const VERSION = Date.now();
const htmlPath = join(DIST, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const bumped = html.replace(
  /(href|src)="(\.\/(?:css|js|vendor|data|assets)\/[^"]+\.(?:css|js|png|jpe?g|webp|svg|ico))"/g,
  (_m, attr, url) => `${attr}="${url}?v=${VERSION}"`
);
writeFileSync(htmlPath, bumped);
for (const d of dirs) {
  const { n, bytes } = cpDir(d);
  total += bytes;
  console.log(`  ${(d + '/').padEnd(22)} ${n} 个文件 ${(bytes / 1024).toFixed(1)} KB`);
}

console.log(`\n  缓存版本号 v=${VERSION}`);

console.log(`\n✓ 发布目录就绪：${DIST}`);
console.log(`  总计 ${(total / 1048576).toFixed(2)} MB（原始 site/ 含全量存档约 13MB）`);
