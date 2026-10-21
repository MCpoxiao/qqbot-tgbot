/**
 * **时间戳格式**（2026-10-15 加，起因：用户报「日志的时间是错的」）。
 *
 * 原来项目里到处用 `new Date().toISOString()` —— 那是 **UTC** ✗，
 * 本机东八区 ⇒ 日志比实际**慢 8 小时** ✓；更迷惑的是**日志文件名用 UTC 日期** ✗
 * ⇒ 凌晨 0~8 点写出来的"今天"的日志，里面每一行都写着"昨天" ✓✓。
 *
 * 现在统一走 `localStamp()`：`2026-10-15T12:43:36.614+08:00` ✓
 *   · **人**看就是本地时间 ✓（不用心算 +8）；
 *   · **机器**照样认 ✓（`new Date(这一串)` 得到的瞬间与 UTC 写法**完全相同** ✓，自测钉着）。
 *
 * ⚠️ 放在这个独立小模块里是有意的：`bot.mjs` 与 `src/control.mjs` 都要用它 ✓，
 * 而 control 被 bot 依赖 ⇒ **从 bot 导入会成环** ✗，所以下沉成零依赖的小文件 ✓。
 */

/** 本地时间戳（带显式偏移）✓。 */
export function localStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  // getTimezoneOffset() 是"UTC 减本地"的分钟数（东八区 = -480）⇒ 取负才是常见的 +08:00 ✓
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/** 本地日期（`2026-10-15`）——日志文件名用它 ✓，跟每一行的时间戳对齐 ✓。 */
export function localDateStamp(d = new Date()) {
  return localStamp(d).slice(0, 10);
}
