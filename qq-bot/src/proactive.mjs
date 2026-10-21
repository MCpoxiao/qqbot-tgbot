/**
 * 主动开口：长时间没消息时，自己来找人说话。
 *
 * 这里有个真实风险要设计进去：**主动发消息比被动回复更容易触发风控**——
 * 平台把"没人叫它却自己发消息"看作典型机器人行为。所以默认值刻意保守：
 * 默认关闭、只对私聊、三小时才考虑一次、一天最多两次、夜里免打扰。
 *
 * 决策逻辑抽成纯函数，否则"该不该发"这件事只能靠真等三小时才能验。
 */

/** 是否处于免打扰时段。支持跨午夜（from=23, to=8）。 */
export function inQuietHours(date, { from = 23, to = 8 } = {}) {
  const h = date.getHours();
  if (from === to) return false;
  if (from < to) return h >= from && h < to;
  return h >= from || h < to;
}

/**
 * 现在该不该主动开口？
 * @returns {{ping:boolean, reason:string}}
 */
export function shouldPing({
  now,
  lastActivityAt,
  lastPingAt = 0,
  pingsToday = 0,
  cfg,
  date = new Date(now),
}) {
  if (!cfg?.enabled) return { ping: false, reason: '功能没开' };
  if (!lastActivityAt) return { ping: false, reason: '还没有过对话' };

  const idleMin = (now - lastActivityAt) / 60000;
  if (idleMin < cfg.afterMinutes) {
    return { ping: false, reason: `才安静了 ${Math.floor(idleMin)} 分钟，没到 ${cfg.afterMinutes} 分钟` };
  }
  if (lastPingAt && (now - lastPingAt) / 60000 < cfg.minGapMinutes) {
    return { ping: false, reason: '距上次主动开口还不够久' };
  }
  if (pingsToday >= cfg.maxPerDay) return { ping: false, reason: `今天已经主动说过 ${pingsToday} 次了` };
  if (inQuietHours(date, cfg.quietHours)) return { ping: false, reason: '免打扰时段' };

  return { ping: true, reason: 'ok' };
}

/** 把会话 key 还原成发送目标。key 形如 `private:123` / `group:456`。 */
export function parseSessionKey(key) {
  const i = key.indexOf(':');
  const type = key.slice(0, i);
  const id = key.slice(i + 1);
  if (type !== 'private' && type !== 'group') return null;
  return { type, id };
}
