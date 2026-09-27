/**
 * 把口袋48 的 pa 签名模块的 **wasm-bindgen 胶水** 内联进 worker/index.js。
 *
 * wasm 本体不内联：🔴 Cloudflare Workers **禁止运行时编译 wasm**
 *   （实测报错 `Wasm code generation disallowed by embedder`），
 *   必须用 wrangler.jsonc 的 `rules: [{ type: "CompiledWasm" }]` 把 .wasm 预编译成
 *   WebAssembly.Module 再 import（见 worker/index.js 顶部的 `import PA_MODULE`）。
 * 胶水（纯 JS、只用 TextDecoder/WebAssembly）没有这个限制，内联即可，
 * 这样 worker/index.js 不需要依赖 esbuild 去解析相对 import。
 *
 * 用法：node scripts/gen-pa-inline.mjs
 * 它会替换 worker/index.js 里 /* ==== PA_INLINE_BEGIN ==== *\/ … /* ==== PA_INLINE_END ==== *\/ 之间的内容。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const gluePath = resolve(root, 'scraper/lib/rust-wasm.js');
const workerPath = resolve(root, 'worker/index.js');

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
  ' * 口袋48 的反爬签名 pa：wasm 本体由 wrangler 预编译成 PA_MODULE（见文件顶部 import），',
  ' * 这里只是 wasm-bindgen 的胶水（把 wasm 返回的 [ptr,len] 解成 JS 字符串）。',
  ' * 对外只暴露 paSign()：懒加载，第一次用到才实例化。',
  ' * ---------------------------------------------------------------------- */',
  'let PA_READY = null;',
  'async function paInitOnce() {',
  '  // PA_MODULE 是 wrangler 预编译好的 WebAssembly.Module（rules: CompiledWasm）',
  '  if (!PA_READY) PA_READY = __wbg_init(PA_MODULE).then(() => true);',
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
console.log('已内联 pa 胶水：worker/index.js 现 ' + src.length + ' 字节（wasm 本体走 CompiledWasm 规则预编译导入）');
