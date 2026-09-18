// 生成发布目录 dist/：只包含站点运行必需的文件。
// 目的：site/data 里的 messages.json / live.json / performances.json 是完整存档（十几 MB），
// 网页实际只需要已合并好的 archive.js，打包进发布目录会拖慢加载甚至超出部署体积限制。
// 用法：node scripts/build-dist.mjs
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
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

const files = [
  'index.html',
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
  'data/archive.js'
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
console.log(`\n  缓存版本号 v=${VERSION}`);

console.log(`\n✓ 发布目录就绪：${DIST}`);
console.log(`  总计 ${(total / 1048576).toFixed(2)} MB（原始 site/ 含全量存档约 13MB）`);
