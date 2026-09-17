// 获取 POCKET48_TOKEN
// 用法：node get-token.mjs
//
// 方式 A：粘贴已有 token（从抓包 / 桌面版 48tools 拿到），直接写入 .env
// 方式 B：手机号 + 短信验证码登录
//   - 若为外国手机号（非 +86），官方会返回一道饭圈知识题，
//     工具会显示题目与选项，由用户作答后连同 answer 重发。
//
// ⚠️ 重要：每调用一次「发送验证码」接口而未答对，都会消耗一次答题机会；
//    连续失败 3 次会锁 24 小时。因此工具严禁盲目重试——仅在用户作答后重试一次。
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sendSms, loginMobileCode } from './lib/api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '.env');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (t) => (await rl.question(t)).trim();

function writeTokenToEnv(token) {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  if (/^\s*POCKET48_TOKEN=.*$/m.test(content)) {
    content = content.replace(/^\s*POCKET48_TOKEN=.*$/m, `POCKET48_TOKEN=${token}`);
  } else {
    content += `\nPOCKET48_TOKEN=${token}\n`;
  }
  writeFileSync(ENV_PATH, content);
}

function printVerification(v) {
  console.log('\n=== 需要通过人机验证（国外手机号）===');
  console.log('题目：' + v.question);
  for (const a of v.answer) console.log(`  [${a.option}] ${a.value}`);
  console.log('');
}

async function main() {
  console.log('=== 获取口袋48 Token ===\n');

  const hasToken = await ask('你是否已有 token？（可输入 y 后粘贴，直接回车则用短信登录）[y/N]: ');
  if (/^y$/i.test(hasToken)) {
    const token = await ask('粘贴 token: ');
    if (!token) { console.error('token 不能为空'); process.exit(1); }
    writeTokenToEnv(token);
    console.log(`\n✓ 已写入 ${ENV_PATH}`);
    console.log('  现在可以运行：node scrape.mjs');
    return;
  }

  const area = (await ask('手机号区号（大陆 86，日本 81，直接回车默认 86）：')) || '86';
  const mobile = await ask('口袋48 绑定手机号（不含区号）：');
  if (!mobile) { console.error('手机号不能为空'); process.exit(1); }

  if (!existsSync(ENV_PATH) || !/SCRAPE_PROXY=/m.test(readFileSync(ENV_PATH, 'utf8') || '')) {
    console.warn('⚠ 未在 .env 检测到 SCRAPE_PROXY，境外直连口袋48 会返回 403。');
  }

  let answer = undefined;
  // 首次发送：不带答案（外国号会返回题目）
  let smsOk = false;
  try {
    await sendSms(mobile, area);
    smsOk = true;
  } catch (e) {
    if (!e.verification) throw e;
    printVerification(e.verification);
    const picked = await ask('请输入正确选项的编号（或完整文本）：');
    const hit = e.verification.answer.find(
      (a) => String(a.option) === picked || a.value === picked
    );
    answer = hit ? hit.value : picked;
    console.log('→ 已选择答案：' + answer + '，重发验证码（仅此一次，避免锁号）');
    await sendSms(mobile, area, answer); // 不再重试第二次
    smsOk = true;
  }
  if (!smsOk) return;

  console.log('✓ 短信已发送，请查收');
  const code = await ask('输入短信验证码：');
  console.log('→ 正在登录...');
  const info = await loginMobileCode(mobile, code);

  console.log('✓ 登录成功！');
  console.log('  昵称：', info.nickname || '(未知)');
  console.log('  userId：', info.userId || '(未知)');
  console.log('  token：', (info.token || '').slice(0, 12) + '…（已隐去）');

  writeTokenToEnv(info.token);
  console.log(`\n✓ 已写入 ${ENV_PATH}`);
  console.log('   现在可以运行：node scrape.mjs  抓取口袋发言了');
}

main()
  .catch((e) => {
    console.error('\n✗ 失败：', e.message);
    if (/24小时|不可再答题/.test(e.message || '')) {
      console.error('提示：该号码答题机会已用尽，24 小时内无法再通过短信获取验证码。');
      console.error('      可改用「粘贴已有 token」的方式（从抓包或桌面版 48tools 获取）。');
    }
    process.exit(1);
  })
  .finally(() => rl.close());
