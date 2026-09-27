/**
 * 把口袋48 的 pa 签名模块（pa.wasm + wasm-bindgen 胶水）内联进 worker/index.js。
 *
 * 为什么不用 import：CF 是「Git 构建」，不能赌它的 esbuild 一定会处理 .wasm / 相对 import。
 * 内联成一个大字符串常量后，worker/index.js 仍是**单文件**，任何构建方式都能跑。
 *
 * 用法：node scripts/gen-pa-inline.mjs
 * 它会替换 worker/index.js 里 /* ==== PA_INLINE_BEGIN ==== *\/ … /* ==== PA_INLINE_END ==== *\/ 之间的内容。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const wasmPath = resolve(root, 'scraper/lib/pa.wasm');
const gluePath = resolve(root, 'scraper/lib/rust-wasm.js');
const workerPath = resolve(root, 'worker/index.js');

const wasmBuf = await readFile(wasmPath);
const b64 = wasmBuf.toString('base64');

let glue = await readFile(gluePath, 'utf8');
// 去掉 ESM 导出语法：内联进单文件后不需要 export
glue = glue
  .replace(/^export\s+default\s+__wbg_init;?\s*$/m, '')
  .replace(/^export\s*\{[^}]*\}\s*;?\s*$/m, '')
  .replace(/^export\s+/gm, '')
  .trim();

const BEGIN = '/* ==== PA_INLINE_BEGIN ==== */';
const END = '/* ==== PA_INLINE_END ==== */';

const block = [
  BEGIN,
  '/* ------------------------------------------------------------------------',
  ' * 【自动生成，请勿手改】由 scripts/gen-pa-inline.mjs 生成。',
  ' * 口袋48 的反爬签名 pa：由 Rust 编译的 wasm 生成，wasm-bindgen 胶水在下面。',
  ' *   - PA_B64：pa.wasm 的 base64（52KB）；运行时 atob 解出字节后实例化。',
  ' *   - paSign()：返回签名字符串（懒加载，第一次用到才实例化 wasm）。',
  ' * 为什么内联：CF 是 Git 构建，不能依赖 esbuild 处理 .wasm import；单文件最稳。',
  ' * ---------------------------------------------------------------------- */',
  `const PA_B64 = '${b64}';`,
  '',
  'let PA_BYTES = null;',
  'function paBytes() {',
  '  if (PA_BYTES) return PA_BYTES;',
  '  const bin = atob(PA_B64);',
  '  const out = new Uint8Array(bin.length);',
  '  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);',
  '  PA_BYTES = out;',
  '  return out;',
  '}',
  '',
  'let PA_READY = null;',
  'async function paInitOnce() {',
  '  if (!PA_READY) PA_READY = __wbg_init(paBytes()).then(() => true);',
  '  return PA_READY;',
  '}',
  '',
  '/** 生成口袋48 请求头里的 pa 签名（反爬，缺了会 403） */',
  'async function paSign() {',
  '  await paInitOnce();',
  '  return __x6c2adf8__();',
  '}',
  '',
  '/* ---- 下面是 wasm-bindgen 生成的胶水（原样搬运，仅去掉 export） ---- */',
  glue,
  END
].join('\n');

let src = await readFile(workerPath, 'utf8');
const i = src.indexOf(BEGIN);
const j = src.indexOf(END);
if (i < 0 || j < 0) {
  // 还没插过：追加到文件末尾（worker/index.js 的 export default 在开头，末尾追加安全）
  src = src.replace(/\s*$/, '\n\n') + block + '\n';
} else {
  src = src.slice(0, i) + block + src.slice(j + END.length);
}
await writeFile(workerPath, src);
console.log('已内联 pa 签名模块：base64 ' + b64.length + ' 字符，worker/index.js 现 ' + src.length + ' 字节');
