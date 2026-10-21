/**
 * 提醒（定时任务）。
 *
 * **为什么要有这个模块**：2026-10-07 用户在私聊里说「你2分钟后提醒我写」，
 * 小笛回「现在开始计时」—— 而它**根本没有任何定时能力**（全项目只有重连、
 * 落盘防抖、心跳，还有那个 3 小时才可能开口一次的"主动找话题"）。
 * 于是承诺落空、用户白等。这正是老教训的又一次复现：
 * **「写在提示词里 / 嘴上说了」和「它真的会做」是两件事，凡是希望它一定会做的事，
 * 一律用代码兜。**
 *
 * 设计要点：
 * 1. **落盘**（`logs/reminders.json`）：小笛重启很频繁（改代码、NapCat 掉了、关机），
 *    只放内存里的提醒会被静默吃掉。
 * 2. **时间只认两种说法**：`after_minutes`（几分钟后）与 `at`（"21:30"，过点了算明天）。
 *    再复杂的（"后天早上九点"）让模型自己换算成分钟 —— 时间解析越花，错得越隐蔽。
 * 3. **只给主人的私聊**（和操控那套同一个闸）—— 提醒的本质是**机器人主动发消息**，
 *    群里的定时等于定时刷屏，还会招风控。
 * 4. 纯逻辑（什么时候到点、能不能加、怎么取消）都抽成可测函数，**不依赖真实计时器**。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 上限：拖着 20 个提醒不放没有意义，只会把落盘文件越堆越大。 */
const MAX_PENDING = 10;
const MIN_LEAD_MS = 60 * 1000; // 最快 1 分钟
const MAX_LEAD_MS = 7 * 24 * 3600 * 1000; // 最远 7 天

/**
 * 用户这句话**是在要一个提醒吗**？
 *
 * 为什么要它：谎话闸原来只看回复里有没有「提醒你/到点」，结果**误报**了 ——
 * 2026-10-07 17:24 它自己主动提议「要我给你设个提醒吗，七点整」，那句里带着「到点」，
 * 闸门就判成"它答应了却没做"，往回复里塞了一句认错的话。**用户根本没要提醒。**
 * 所以判据要两头都成立：**他先要了**，**它又答应了**。
 */
export function looksLikeReminderAsk(userText) {
  const s = String(userText ?? '');
  return (
    /(提醒我|叫我|喊我|提醒一下)/.test(s) ||
    /(几|点|\d{1,2}:\d{2})[^。！？]{0,8}(提醒|叫我|喊我|提我)/.test(s) ||
    /(到点|到时候)[^。！？]{0,6}(提醒|叫我|喊我)/.test(s)
  );
}

/** 回复里**有没有"我会提醒你"这种承诺**（问句不算：征询不是承诺）。 */
export function promisesReminder(reply) {
  for (const s of String(reply ?? '').split(/[。！!？?\n]/)) {
    if (!/(提醒你|喊你|叫你|提你)/.test(s)) continue;
    if (/吗|要不要|需不需要|好不|用不用/.test(s)) continue; // 征询 ≠ 承诺
    if (/我/.test(s)) return true;
  }
  return false;
}

/**
 * 把「几分钟后 / 某个钟点」换算成一个绝对时间戳。
 * @returns {{at:number, rolled?:boolean}|{error:string}}
 */
export function resolveWhen({ afterMinutes, at } = {}, now = Date.now()) {
  const minutes = Number(afterMinutes);
  if (Number.isFinite(minutes) && minutes > 0) {
    const ms = Math.round(minutes * 60000);
    if (ms < MIN_LEAD_MS) return { error: '太近了，最短 1 分钟。' };
    if (ms > MAX_LEAD_MS) return { error: '太远了，最长 7 天（更远的请你自己记着）。' };
    return { at: now + ms };
  }

  const m = String(at ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return { error: '钟点写得不对，用 24 小时制，例如「21:30」。' };
    const d = new Date(now);
    d.setHours(h, mi, 0, 0);
    let rolled = false;
    if (d.getTime() <= now) {
      d.setDate(d.getDate() + 1);
      rolled = true;
    }
    return { at: d.getTime(), rolled };
  }

  return { error: '没说明白什么时候 —— 用 after_minutes（几分钟后）或 at（如「21:30」）。' };
}

/** 还有多久（人话）。 */
export function humanizeGap(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h < 24) return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

/** 「今天/明天 21:30」这种给人看的写法。 */
export function humanizeWhen(ts, now = Date.now()) {
  const d = new Date(ts);
  const t = new Date(now);
  const sameDay = d.toDateString() === t.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}（${humanizeGap(ts - now)}后）`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/**
 * 提醒仓库：内存 + 一个 JSON 文件。
 * **不自己跑计时器** —— 什么时候检查由 bot.mjs 的心跳决定，这样逻辑可测。
 */
export class Reminders {
  constructor({ file = null, log = console } = {}) {
    this.file = file;
    this.log = log;
    this.list = [];
    if (file) this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) {
        this.list = raw.filter((x) => x && Number.isFinite(x.dueAt) && x.text);
        this.log.info?.(`读回了 ${this.list.length} 条待提醒`);
      }
    } catch (err) {
      this.log.warn?.(`提醒文件读不出来（${err.message}），这次当空的处理`);
      this.list = [];
    }
  }

  save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.list, null, 2) + '\n');
    } catch (err) {
      this.log.warn?.(`提醒存不下来（${err.message}）—— 重启会丢`);
    }
  }

  /** 某个用户还能挂几条。 */
  countFor(userId) {
    return this.list.filter((r) => String(r.userId) === String(userId)).length;
  }

  /**
   * 加一条。
   * @returns {{ok:true,item:object}|{ok:false,error:string}}
   */
  add({ userId, text, dueAt, now = Date.now() }) {
    const what = String(text ?? '').trim();
    if (!what) return { ok: false, error: '没说提醒你干什么。' };
    if (what.length > 200) return { ok: false, error: '要提醒的事太长了，缩到 200 字以内。' };
    if (!Number.isFinite(dueAt)) return { ok: false, error: '时间没算出来。' };
    /**
     * ⚠️ 这里要比 `resolveWhen` 松 5 秒。
     * 原因：`dueAt` 是用**更早**的一次 `Date.now()` 算出来的（resolveWhen 里），
     * 到这里再取一次 `now` 已经过了几毫秒 —— 于是「1 分钟后提醒我」算出来是 60000 - 几毫秒，
     * 被这条 `< MIN_LEAD_MS` 判成"太近了"，**用户说的一分钟永远设不上**（2026-10-07 实测）。
     * 两处判据不一致就等于一个必定踩的坑，所以留 5 秒容差。
     */
    if (dueAt - now < MIN_LEAD_MS - 5000) return { ok: false, error: '太近了，最短 1 分钟。' };
    if (dueAt - now > MAX_LEAD_MS) return { ok: false, error: '太远了，最长 7 天。' };
    if (this.countFor(userId) >= MAX_PENDING) {
      return { ok: false, error: `已经挂着 ${MAX_PENDING} 条了，先取消几条（发「看我有哪些提醒」）。` };
    }
    const item = { id: `R${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`, userId: String(userId), text: what, dueAt, createdAt: now };
    this.list.push(item);
    this.list.sort((a, b) => a.dueAt - b.dueAt);
    this.save();
    return { ok: true, item };
  }

  /** 按 id 或**正文关键字**取消（"取消写单词那个"最自然）。 */
  cancel(userId, match) {
    const key = String(match ?? '').trim().toLowerCase();
    const mine = this.list.filter((r) => String(r.userId) === String(userId));
    if (!mine.length) return { ok: false, error: '你名下没有待提醒的事。' };
    if (!key) return { ok: false, error: '要取消哪一条？说个关键字，或者发「看我有哪些提醒」。' };
    const hit = mine.find((r) => r.id.toLowerCase() === key) ?? mine.find((r) => r.text.toLowerCase().includes(key));
    if (!hit) return { ok: false, error: `没找到「${match}」对应的提醒。` };
    this.list = this.list.filter((r) => r.id !== hit.id);
    this.save();
    return { ok: true, item: hit };
  }

  /** 到点该发的（不删除，等发出去再 markFired）。 */
  due(now = Date.now()) {
    return this.list.filter((r) => r.dueAt <= now && !r.firedAt);
  }

  markFired(id, now = Date.now()) {
    const hit = this.list.find((r) => r.id === id);
    if (hit) hit.firedAt = now;
    this.list = this.list.filter((r) => !r.firedAt);
    this.save();
  }
}

/* ─────────────────────────── 给模型的工具定义 ─────────────────────────── */

export const REMINDER_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description:
        '给自己设一个**真的会响**的提醒（机器人到点会主动发消息）。主人说「X 分钟后提醒我…」「今晚 9 点提醒我…」时**必须**用这个工具 —— 光在回复里说「我会提醒你」是假的，你没有任何记忆和计时能力。只支持：几分钟后，或今天/明天的某个钟点（如 21:30）。更远的（后天、下周）请自己换算成 after_minutes。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '到点要提醒他做什么，例如「写单词」「吃药」' },
          after_minutes: { type: 'number', description: '多少分钟后提醒（1 分钟 ~ 7 天）' },
          at: { type: 'string', description: '钟点，24 小时制如「21:30」；已过点就算明天。与 after_minutes 二选一' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: '看他现在挂着哪些提醒（主人问「我有哪些提醒」「还差多久」时用）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description: '取消一个提醒。主人说「取消写单词那个」「别提醒了」时用；match 给正文里的关键字就行。',
      parameters: {
        type: 'object',
        properties: { match: { type: 'string', description: '要取消哪一条（正文关键字或 id）' } },
        required: ['match'],
      },
    },
  },
];

export const REMINDER_TOOL_NAMES = new Set(REMINDER_TOOL_DEFS.map((d) => d.function.name));

/** 提醒也**只在主人的私聊**里存在（见文件头第 3 条）。 */
export function remindersAllowed(cfg, ctx) {
  if (cfg?.reminders?.enabled === false) return false;
  if (!ctx || typeof ctx !== 'object') return false;
  return ctx.isPrivate === true && ctx.isMaster === true;
}

/** 待提醒列表 → 人话。 */
export function formatList(items, now = Date.now()) {
  if (!items.length) return '现在没有挂着的提醒。';
  return items
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((r, i) => `${i + 1}. ${humanizeWhen(r.dueAt, now)} 提醒你 ${r.text}`)
    .join('\n');
}

/**
 * 执行一次提醒类工具。**永远返回字符串、永远不抛**。
 * 存储实例由调用方通过 `ctx.reminders` 传进来（测试里给个临时文件的即可）。
 */
export async function runReminderTool(cfg, name, args = {}, ctx = null) {
  if (!REMINDER_TOOL_NAMES.has(name)) return `错误：没有叫 ${name} 的提醒工具。`;
  if (!remindersAllowed(cfg, ctx)) return '提醒只能在主人的私聊里设（群里不行）。';
  const store = ctx?.reminders;
  if (!store) return '提醒功能这会儿没挂上（内部错误）。';

  const userId = ctx.userId ?? 'unknown';
  const a = args ?? {};
  try {
    if (name === 'set_reminder') {
      const when = resolveWhen({ afterMinutes: a.after_minutes, at: a.at });
      if (when.error) return `没设成：${when.error}`;
      const res = store.add({ userId, text: a.text, dueAt: when.at });
      if (!res.ok) return `没设成：${res.error}`;
      const extra = when.rolled ? '（那个点今天已经过了，按明天算）' : '';
      return `设好了：${humanizeWhen(res.item.dueAt)} 提醒你「${res.item.text}」${extra}`;
    }

    if (name === 'list_reminders') {
      const mine = store.list.filter((r) => String(r.userId) === String(userId));
      return formatList(mine);
    }

    if (name === 'cancel_reminder') {
      const res = store.cancel(userId, a.match);
      return res.ok ? `取消了「${res.item.text}」那条提醒。` : res.error;
    }

    return `错误：提醒工具 ${name} 还没实现。`;
  } catch (err) {
    return `提醒功能出错：${err.message}`;
  }
}
