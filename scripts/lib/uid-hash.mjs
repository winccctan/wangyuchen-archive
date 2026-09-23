/*
 * uid 脱敏哈希（供「榜单覆盖表脱敏」与 CI 查表共用）。
 *
 * 用途：data/fans-2026-gift.json（2026 第三方榜单覆盖表）的 key 原本是明文 uid，
 * 不能进公开仓库；但 CI 每天要跑 build-fans.mjs --push，读不到就会把 191 人的
 * total2026 静默打回自算值。改成 key = "h:" + sha256(uid) 前 16 位（64 bit）后，
 * 仓库里看不出是谁，构建脚本对每个粉丝 uid 算同样的 hash 即可完整还原。
 * 不可逆；191 个 uid 在 64 bit 空间下碰撞概率约 1e-15。
 */
import crypto from 'node:crypto';

export const hashUid = (uid) => 'h:' + crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 16);
export const isHashed = (k) => String(k).startsWith('h:');
