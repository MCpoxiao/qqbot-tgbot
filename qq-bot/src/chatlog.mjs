/**
 * **7 天聊天记录归档**（2026-10-11 用户要求）：
 * 「7 天内的所有聊天记录（所有包括图片、引用之类）都保存下来作为完整记忆，
 *   第八天就删除第一天的记录，重要的还是留到长期里」。
 *
 * ## 它和"长期记忆"的分工（别搞混，这是设计要点）
 *
 * | 层 | 存什么 | 活多久 | 谁来写 |
 * | --- | --- | --- | --- |
 * | **本模块（原始归档）** | **每条**进出消息的原文/段结构（图/引用/@/表情/文件…）+ 图片文件 | **滚动 7 天**，第 8 天删第 1 天 | 代码自动，**不过模型** |
 * | `src/memory.mjs`（长期） | 档案（事实，带时效）+ 日记 + 草稿 | 长期 | **先审后记**：模型提取 → 存草稿 → **主人点头**才落盘 |
 *
 * 所以"重要的留到长期里"**不靠这个模块**：它只保证"最近 7 天我说过的都还在、能翻出来"，
 * 长期那条链一直没变。本模块**不改写 memory.mjs 的任何东西**。
 *
 * ## 落盘布局
 *
 * ```
 * logs/chat/2026-10-11.jsonl          ← 一天一行一个 JSON（in/out 都写这里）
 * logs/chat/media/2026-10-11/<sha8>.jpg  ← 图片按**内容 sha** 去重存
 * ```
 * 每行形如：
 * ```json
 * {"at":175..., "day":"2026-10-11", "dir":"in", "scope":"private", "key":"private:10000000",
 *  "sender":{"id":"10000000","nickname":"主人"}, "text":"找张胡桃的图",
 *  "segments":[{"type":"text","text":"…"},{"type":"image","url":"…"}],
 *  "media":[{"sha":"ab12…","file":"media/2026-10-11/ab12cd34.jpg","bytes":81234,"mime":"image/jpeg"}]}
 * ```
 *
 * ## 几条刻意的取舍
 *
 * - **追加写、一行一个 JSON**：写坏一行不影响其它行（不像一个大 JSON 文件那样全废）。
 * - **图片按 sha 去重 + 两道体积上限**（单张 / 每天）：群里同一张图被转来转去不会存很多份；
 *   超限的**不下载**并记一条 `skipped`，而不是让归档把磁盘吃光。
 * - **认不出的日期文件名不删**（`prunePlan` 里只删严格匹配 `YYYY-MM-DD.jsonl` 的），
 *   免得哪天目录里放了别的东西被顺手清掉。
 * - **7 天是滚动窗口**：删的判据是"那一天的日期 < 今天-(ttl-1)"，与"跑没跑过"无关，
 *   所以重启、跨天、停机几天后再开都能自愈。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { localDay } from './memory.mjs';

/** 本地日（复用 memory.mjs 的定义，别各写一套 —— 两处不一致会出现"跨天算错一天"）。 */
export function dayKey(ts = Date.now(), tz = 'Asia/Shanghai') {
  return localDay(ts, tz);
}

/** `YYYY-MM-DD` 加减天数（**按 UTC 解析再回字符串**，避免时区把日期推错一天）。 */
export function shiftDay(key, deltaDays) {
  const m = String(key ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(key ?? '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → `YYYY.MM.DD`（用户 2026-10-11 指定的目录名风格）。 */
export function dayFolderName(day) {
  return String(day ?? '').replace(/-/g, '.');
}

/** `YYYY.MM.DD` → `YYYY-MM-DD`（内部一律用 ISO 形式比较）。 */
export function dayKeyFromFolder(name) {
  return String(name ?? '').replace(/\./g, '-');
}

/** 是不是"一天的文件夹"（两种写法都认：新结构用点，老结构用横线）。 */
export function isDayFolder(name) {
  return /^\d{4}[.\-]\d{2}[.\-]\d{2}$/.test(String(name ?? ''));
}

/** 那一刻属于哪个小时档（两位，`00`~`23`）。 */
export function hourName(at) {
  const h = new Date(Number(at) || 0).getHours();
  return String(h).padStart(2, '0');
}

/**
 * **小时档的文件名**（用户 2026-10-11 定的）：`<HH>-<mm>-<ss>.jsonl`
 * —— 用**这个档挂上那一刻**的时分秒，而不是只写个 `13.jsonl`。
 *
 * 为什么这么设计：一天仍是 24 个档（翻起来是一个小时的连续对话），
 * 但文件名自带"这段从几点几分几秒开始"，不用打开就知道边界在哪。
 */
export function hourFileName(at) {
  const d = new Date(Number(at) || 0);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.jsonl`;
}

/** 从档名取"属于哪个小时"（`13-59-07.jsonl` → `13`；老写法 `13.jsonl` 也认）。 */
export function hourPrefixOf(name) {
  const m = String(name ?? '').match(/^(\d{2})(?:-\d{2}-\d{2})?\.jsonl$/);
  return m ? m[1] : '';
}

/**
 * ⚠️ **把"人话里的时间"解析成一个具体时间段**（2026-10-11 用户要的：
 * 「让他去对着时间找，比如今早发生的事就去早上的时间段找，昨晚就去晚上的时间段找，
 *   昨天就去当前日期的前一天找，以此类推」）。
 *
 * 纯函数、可单测。认得这些说法（**先长后短**匹配，避免「昨天早上」被「昨天」先吃掉）：
 *
 * | 说法 | 解析成 |
 * | --- | --- |
 * | 今早 / 今天早上 / 今晨 | 今天 05:00 ~ 12:00 |
 * | 上午 / 中午 / 下午 / 傍晚 / 晚上 / 深夜 | 今天对应时段 |
 * | 昨晚 / 昨天晚上 | **昨天** 18:00 ~ 24:00 |
 * | 昨天早上 / 昨天下午 | **昨天**对应时段 |
 * | 昨天 / 昨日 | 昨天整天 |
 * | 前天 / 大前天 | 前两天 / 前三天整天 |
 * | 刚才 / 刚刚 | 最近 30 分钟 |
 * | 今天 / 现在 | 今天 00:00~现在 / 最近一小时 |
 * | 这几天 / 最近 / 最近 N 天 | 最近 3 天（或 N 天） |
 * | 2026.10.10 / 2026-10-10 / 10月10日 | 那一整天 |
 *
 * 返回 `{ from, to, label, keepFrom, outside }`：
 *   · `from/to` = 毫秒时间戳（闭区间）；
 *   · `label` = 给人看的说法（回给模型，让它如实转述）；
 *   · `keepFrom` = 归档实际保留的起点 —— 窗口会被**夹**到保留范围内；
 *   · `outside` = 用户问的时间**早于保留范围**（要如实说"那会儿的没留着"，别装作查过）。
 * 认不出时间词返回 `null`（调用方按"最近几天"处理）。
 */
export function parseTimeWindow(text, { now = Date.now(), tz = 'Asia/Shanghai', recallDays = 7 } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const today = dayKey(now, tz);
  const at = (day, h, m = 0) => {
    const [y, mo, d] = dayKeyFromFolder(day).split('-').map(Number);
    return new Date(y, mo - 1, d, h, m, 0, 0).getTime();
  };
  const dayStart = (day) => at(day, 0, 0);
  const dayEnd = (day) => at(day, 23, 59, 59) + 999;
  const dayAgo = (n) => shiftDay(today, -n);

  /**
   * ⚠️ **顺序即优先级**（`slotOf` 取第一个命中的）：
   * 「昨晚深夜」既含"昨晚"（晚上）又含"深夜" —— 必须让**更具体的时段**先命中，
   * 否则会退化成"昨晚 18:00 之后"这种大范围。实测第一版就是这个毛病。
   */
  const SLOTS = [
    { re: /凌晨/, h: [0, 5], name: '凌晨' },
    { re: /深夜|半夜|午夜/, h: [23, 24], name: '深夜' },
    // ⚠️ `今早`/`今晨` 必须自己列进来：它们不含"早上/早晨"这几个字，
    //    实测第一版漏了 → 「今早」被当成"今天整天"（用户要的正是"今早只翻早上"）。
    { re: /早上|早晨|今晨|今早|清晨|一早|早间/, h: [5, 12], name: '早上' },
    { re: /上午/, h: [9, 12], name: '上午' },
    { re: /中午|晌午/, h: [11, 14], name: '中午' },
    { re: /下午|后半晌/, h: [12, 18], name: '下午' },
    { re: /傍晚|黄昏/, h: [17, 19], name: '傍晚' },
    { re: /晚上|夜里|夜晚|晚间|今晚|昨晚/, h: [18, 24], name: '晚上' },
  ];
  const slotOf = (s) => SLOTS.find((x) => x.re.test(s));
  const clamp = (from, to, label) => {
    const keepFrom = dayStart(dayAgo(Math.max(0, (Number(recallDays) || 7) - 1)));
    /**
     * ⚠️ 整段都在保留范围之前时，要返回**空窗口**（`from > to`），不能只夹 from：
     * 实测「上周三」夹完变成 `10-05 00:00 ~ 09-30 23:59`（**倒过来的区间**），
     * 读的时候会"看起来有窗口、其实一条都不该有"，还容易误读成"查过了、没有"。
     * 现在：空窗口 + `outside: true` → 调用方会如实说"那会儿的没留着"。
     */
    if (to < keepFrom) return { from: keepFrom, to: keepFrom - 1, label, keepFrom, outside: true };
    return { from: Math.max(from, keepFrom), to, label, keepFrom, outside: false };
  };

  // ① 绝对日期最明确，先认
  const abs = raw.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (abs) {
    const day = `${abs[1]}-${String(abs[2]).padStart(2, '0')}-${String(abs[3]).padStart(2, '0')}`;
    return clamp(dayStart(day), dayEnd(day), day.replace(/-/g, '.'));
  }
  const md = raw.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (md) {
    const day = `${today.slice(0, 4)}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
    return clamp(dayStart(day), dayEnd(day), day.replace(/-/g, '.'));
  }
  // ② 刚才
  if (/刚才|刚刚|刚那会儿/.test(raw)) {
    return { from: now - 30 * 60 * 1000, to: now, label: '刚才（最近半小时）', keepFrom: 0, outside: false };
  }
  // ③ 昨晚（含"晚上"语义，必须先于"昨天整天"；"昨晚深夜/凌晨"再收窄一层）
  if (/昨晚|昨天晚上|昨夜/.test(raw)) {
    const d = dayAgo(1);
    const s = slotOf(raw);
    if (s && s.name !== '晚上') return clamp(at(d, s.h[0], 0), at(d, s.h[1], 0) - 1, `昨晚${s.name}（${d.replace(/-/g, '.')}）`);
    return clamp(at(d, 18, 0), dayEnd(d), `昨晚（${d.replace(/-/g, '.')} 18:00 之后）`);
  }
  // ④ 昨天（±时段）
  if (/昨天|昨日/.test(raw)) {
    const d = dayAgo(1);
    const s = slotOf(raw);
    if (s) return clamp(at(d, s.h[0], 0), at(d, s.h[1], 0) - 1, `昨天${s.name}（${d.replace(/-/g, '.')}）`);
    return clamp(dayStart(d), dayEnd(d), `昨天（${d.replace(/-/g, '.')} 整天）`);
  }
  // ⑤ 前天 / 大前天
  if (/大前天/.test(raw)) {
    const d = dayAgo(3);
    return clamp(dayStart(d), dayEnd(d), `大前天（${d.replace(/-/g, '.')} 整天）`);
  }
  if (/前天/.test(raw)) {
    const d = dayAgo(2);
    return clamp(dayStart(d), dayEnd(d), `前天（${d.replace(/-/g, '.')} 整天）`);
  }
  // ⑤-b 星期几（"周三 / 星期三 / 上礼拜天"）—— 用户说"以此类推"，这类也得认
  {
    const wd = raw.match(/(上上|上个|上|这|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/);
    if (wd) {
      const MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
      const target = MAP[wd[2]];
      const todayIso = ((new Date(at(today, 12, 0)).getDay() + 6) % 7) + 1; // 1=周一 … 7=周日
      let back = (todayIso - target + 7) % 7; // 本週的那一天（今天就算 0）
      if (/上/.test(wd[1] ?? '')) back += 7;
      if (/上上/.test(wd[1] ?? '')) back += 7;
      const d = dayAgo(back);
      const s = slotOf(raw);
      if (s) return clamp(at(d, s.h[0], 0), at(d, s.h[1], 0) - 1, `${raw.match(/(上上|上个|上|这|本)?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]/)[0]}${s.name}（${d.replace(/-/g, '.')}）`);
      return clamp(dayStart(d), dayEnd(d), `${d.replace(/-/g, '.')}（周${wd[2]}${back ? '，往前数' : '，就是今天'}）`);
    }
  }
  // ⑥ 最近 N 天 / 这几天
  if (/前几天|这两天|这几天|最近几天|最近/.test(raw)) {
    const w = raw.match(/最近\s*(\d+)\s*天/);
    const n = Math.min(Number(recallDays) || 7, Math.max(2, w ? Number(w[1]) : 3));
    return clamp(dayStart(dayAgo(n - 1)), now, `最近 ${n} 天`);
  }
  // ⑦ 今天（±时段）
  const s = slotOf(raw);
  if (/今天|今日|今儿|今早|今晨|今晚|现在|这会儿/.test(raw) || s) {
    if (s) {
      const from = at(today, s.h[0], 0);
      const end = at(today, s.h[1], 0) - 1;
      return { from: Math.min(from, now), to: Math.min(end, now), label: `今天${s.name}`, keepFrom: 0, outside: false };
    }
    if (/现在|这会儿/.test(raw)) {
      return { from: now - 60 * 60 * 1000, to: now, label: '最近一小时', keepFrom: 0, outside: false };
    }
    return { from: dayStart(today), to: now, label: '今天', keepFrom: 0, outside: false };
  }
  return null;
}

/**
 * ⚠️ **"他在问过去的事"的提示**（2026-10-11 用户要「让他去对着时间找」时加的）。
 *
 * 为什么需要它：归档**默认不进上下文**（这是省 token 的设计），只有模型主动调 `recall_chat`
 * 才查得到。但模型不一定想到去调 —— 所以在**识别到时间线索**的那些轮里补一行提示，
 * 把该填的 `when` 直接告诉它（约 30 token，且**只在这类消息上**补）。
 *
 * 判据（保守）：句子里同时有**回忆动词/疑问**（说过/聊过/提过/记得/什么/啥/来着）与**时间词**，
 * 或者直接是"昨晚/今早/昨天…"打头的短句。纯闲聊提到"今天"（比如"今天好热"）**不该**触发。
 *
 * @returns {string} 提示文本（空串 = 不补）
 */
export function timeRecallHint(text, { now = Date.now(), recallDays = 7 } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 60) return '';
  const win = parseTimeWindow(raw, { now, recallDays });
  if (!win) return '';
  /**
   * ⚠️ **两道条件都要满足**（第一版只要求"有时间词 + 什么/啥"，结果
   * 「**晚上吃什么**」也被补了提示 —— 那是问**将来**，不是回忆）：
   *   ① `recallWord`：像在回忆（说过/聊过/提过/记得/来着/当时/啥/什么…）；
   *   ② `pastRef`：指向**过去的某一天/某个时段**（昨天/昨晚/前天/今早/刚才/上周三/具体日期/最近…）——
   *      **不含**光秃秃的"今天/今晚/晚上"（那些多半在说将来）。
   */
  const recallWord = /说过|聊过|提过|讲过|记得|忘了|来着|当时|那会儿|问我|说了|啥|什么/.test(raw);
  const pastRef =
    /昨天|昨晚|前天|大前天|今早|今晨|今天早上|今天上午|今天中午|今天下午|刚才|刚刚|上(周|星期|礼拜)|(\d{1,2})月\d{1,2}[日号]|\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}|最近/.test(raw);
  if (!recallWord || !pastRef) return '';  return (
    `【时间线索】他这句话指向 **${win.label}**。要翻那段时间的聊天记录，` +
    `用 \`recall_chat\` 并把 \`when\` 填成他说的那个时间词（例如 when="${raw.slice(0, 8)}"）；` +
    `如果那会儿早于归档保留范围，工具会告诉你"没留着"——那就如实说，**别编**。`
  );
}

/**
 * **给一个小时档做摘要**（纯函数，可单测）。
 *
 * 用户 2026-10-11 的原话：「摘要反正是给她看的，他能看懂就行」——
 * 所以**不追求像人写的**，追求**信息密度 + 模型一眼能读懂**：
 * 时间跨度、条数、谁说的（各多少条）、带了几张图、代表句（开头/结尾/最长的那句）。
 *
 * ⚠️ **本地抽取、不调用模型**：摘要属于归档主链路，不能依赖"那会儿模型能不能用"
 * （2026-10-11 晚上 CPE 网络抖了两次，就是活例子）。失败也永远不影响归档本身。
 *
 * @param {Array<object>} rows 这个小时档里的行（已解析）
 * @returns {string} 一行摘要（空串 = 没内容）
 */
export function summarizeHour(rows, { maxSamples = 3, clip: clipLen = 60 } = {}) {
  const list = (rows ?? []).filter((r) => r && r.dir !== 'media' && String(r.text ?? '').trim());
  if (!list.length) return '';
  const byWho = new Map();
  let images = 0;
  const ts = [];
  for (const r of list) {
    const who = r.dir === 'out' ? '小笛' : r.sender?.nickname || r.sender?.id || '某人';
    byWho.set(who, (byWho.get(who) ?? 0) + 1);
    if ((r.segments ?? []).some((s) => s.type === 'image')) images += 1;
    ts.push(Number(r.at) || 0);
  }
  const min = Math.min(...ts);
  const max = Math.max(...ts);
  const hm = (x) => {
    const d = new Date(x);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const clip = (s) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > clipLen ? `${t.slice(0, clipLen)}…` : t;
  };
  // 代表句：第一句、最后一句、最长的那句（去重）
  const picks = [];
  const add = (r) => {
    if (!r) return;
    const line = `${r.dir === 'out' ? '小笛' : r.sender?.nickname || ''}：${clip(r.text)}`;
    if (!picks.includes(line)) picks.push(line);
  };
  add(list[0]);
  add(list[list.length - 1]);
  add([...list].sort((a, b) => String(b.text ?? '').length - String(a.text ?? '').length)[0]);
  const who = [...byWho.entries()].map(([k, v]) => `${k}${v}`).join('/');
  return (
    `${list.length} 条（${who}）｜${hm(min)}–${hm(max)}` +
    `${images ? `｜图 ${images} 张` : ''}` +
    `｜代表句：${picks.slice(0, maxSamples).join(' ／ ')}`
  );
}

/**
 * ⚠️ **该留哪些、该删哪些**（纯函数，可测）。
 * 保留 `>= 今天-(ttlDays-1)` 的日期；**只认 `YYYY-MM-DD` / `YYYY.MM.DD` 形式的日期**，
 * 其余（`.DS_Store`、`media`、别的东西）一律留在 `keep` 里 —— 绝不删认不出的。
 *
 * ⚠️ **"不像话的日期"一律不删**（2026-10-11 加）：用户会**故意把系统时钟改成过去**
 * （他玩 ARG 要用），那期间归档可能写出 `2003.10.11` 这种目录。
 * 旧逻辑只看"比 cutoff 早"就删 —— 于是时钟一改回来，那些档案**整档消失**（日志实证过）。
 * 现在：`年份 < 2020` 的日期进 `odd`（保留 + 报告），让用户自己决定怎么处理。
 *
 * @returns {{keep:string[], drop:string[], cutoff:string, odd:string[]}}（`keep/drop/odd` 里是**原样**的日期字符串）
 */
export function prunePlan(dayKeys, todayKey, ttlDays = 7) {
  /**
   * ⚠️ **0（或负数）= 永不清理**（2026-10-13 用户要求去掉 7 天限制：「我硬盘估计一两个月左右就买了」）。
   * 旧写法 `Math.max(1, Number(ttlDays) || 7)` 里，`0` 会被 `||` 当假值变成 7 ✗ ——
   * 所以"永久"必须**显式判断**（改错就等于继续白删数据 ✗）。
   */
  const ttl = Number(ttlDays);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return { keep: (dayKeys ?? []).map(String), drop: [], cutoff: '（永久保留，不清理）', odd: [] };
  }
  const cutoff = shiftDay(todayKey, -(ttl - 1));
  const keep = [];
  const drop = [];
  const odd = [];
  for (const k of dayKeys ?? []) {
    const name = String(k);
    if (!isDayFolder(name)) {
      keep.push(name);
      continue;
    }
    const iso = dayKeyFromFolder(name);
    // 2020 年以前的一律当"时钟被改过"的证据留着（真有 2019 年前的档也就几十 KB，不心疼）
    if (iso < '2020-01-01') {
      keep.push(name);
      odd.push(name);
      continue;
    }
    if (iso >= cutoff) keep.push(name);
    else drop.push(name);
  }
  return { keep, drop, cutoff, odd };
}

/** CQ 码字符串 → 段数组（`raw_message` 那种形态；能认出来就行，不追求完整实现）。 */
export function parseCq(raw) {
  const s = String(raw ?? '');
  const out = [];
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) {
      const t = s.slice(last, m.index);
      if (t) out.push({ type: 'text', data: { text: t } });
    }
    const data = {};
    for (const kv of String(m[2] ?? '').split(',')) {
      const i = kv.indexOf('=');
      if (i > 0) data[kv.slice(0, i)] = kv.slice(i + 1);
    }
    out.push({ type: m[1], data });
    last = m.index + m[0].length;
  }
  if (last < s.length) {
    const t = s.slice(last);
    if (t) out.push({ type: 'text', data: { text: t } });
  }
  return out;
}

/**
 * 把消息段归一成**归档用的稳定形状**（纯函数，可测）。
 * 只留"以后翻记录时真有用"的字段：文本、图片地址、引用 id、@ 谁、表情 id、文件/语音/视频的名字。
 * 别的类型原样留着 `type`，**不丢** —— 今天认不出，明天可能就想查。
 */
export function normalizeSegments(message, selfId = '') {
  const segs = Array.isArray(message) ? message : parseCq(message);
  /**
   * ⚠️ **两种段形状都要认**（2026-10-12 修的真 bug）：
   *   · OneBot 形状（**收到的**消息是这种）：`{ type:'text', data:{ text } }`
   *   · **内部形状**（`trySendRich()` 那条"发出去"的路传的就是这种）：`{ type:'text', text }`
   * 之前只读 `s.data.text` ⇒ **她发出去的话全被存成空文本**
   * （当天实测：10-11 的 174 条"发出"记录里 **164 条 text 为空、segments 甚至为 null**）。
   * 后果很实：**7 天记忆里只有主人说的话、没有小笛说的话** ——
   * 引用自己的话、"我上次怎么说的"这类回忆全都查不到。
   * 现在统一取 `const d = s.data ?? s`（有 data 用 data，没有就把段自己当数据）。
   */
  const out = [];
  for (const s of segs) {
    const t = String(s?.type ?? '');
    const d = s?.data ?? s ?? {};
    if (t === 'text') {
      const text = String(d.text ?? '');
      if (text) out.push({ type: 'text', text });
    } else if (t === 'image') {
      out.push({ type: 'image', url: String(d.url ?? ''), file: String(d.file ?? ''), sub: String(d.sub_type ?? '') });
    } else if (t === 'reply') {
      out.push({ type: 'reply', id: String(d.id ?? '') });
    } else if (t === 'at') {
      out.push({ type: 'at', qq: String(d.qq ?? ''), me: String(d.qq ?? '') === String(selfId) });
    } else if (t === 'face') {
      out.push({ type: 'face', id: String(d.id ?? '') });
    } else if (t === 'record') {
      out.push({ type: 'record', file: String(d.file ?? '') });
    } else if (t === 'video') {
      out.push({ type: 'video', file: String(d.file ?? '') });
    } else if (t === 'file') {
      out.push({ type: 'file', name: String(d.name ?? ''), size: Number(d.size ?? 0) || 0 });
    } else if (t === 'json' || t === 'xml') {
      out.push({ type: t, preview: String(d.data ?? '').slice(0, 200) });
    } else if (t) {
      out.push({ type: t, data: d });
    }
  }
  return out;
}

/** 段数组 → 一行可读文本（搜索、日志、给模型的摘要都用它）。 */
export function segmentsToText(segments) {
  const parts = [];
  for (const s of segments ?? []) {
    if (s.type === 'text') parts.push(s.text);
    else if (s.type === 'image') parts.push('[图片]');
    // ⚠️ 引用的内容**要进正文**：不然"当时引的是哪句话"搜不到也看不出（2026-10-11 用户担心过）
    else if (s.type === 'reply') parts.push(s.quote?.text ? `[引用${s.quote.who ? ` ${s.quote.who}` : ''}：${String(s.quote.text).slice(0, 60)}]` : '[引用]');
    else if (s.type === 'at') parts.push(s.me ? '[@我]' : `[@${s.qq}]`);
    else if (s.type === 'face') parts.push('[表情]');
    else if (s.type === 'record') parts.push('[语音]');
    else if (s.type === 'video') parts.push('[视频]');
    else if (s.type === 'file') parts.push(`[文件${s.name ? `:${s.name}` : ''}]`);
    else parts.push(`[${s.type}]`);
  }
  return parts.join('').trim();
}

function extFromUrl(url, mime = '', fallback = 'jpg') {
  const m = String(url ?? '').match(/\.(jpe?g|png|gif|webp|bmp|mp4|mov|webm|m4v)(?:\?|$)/i);
  if (m) {
    const e = m[1].toLowerCase();
    return e === 'jpeg' ? 'jpg' : e;
  }
  if (/png/i.test(mime)) return 'png';
  if (/gif/i.test(mime)) return 'gif';
  if (/webp/i.test(mime)) return 'webp';
  if (/mp4|video/i.test(mime)) return 'mp4';
  return fallback;
}

export class ChatArchive {
  /** 总容量守卫状态：置 true 后**只记文字、不再存图**（腾出空间后重启即恢复）。 */
  #mediaDisabled = false;

  /** 图片目录不可用时只告警一次（外接盘没插的情况会一直失败，别刷屏）。 */
  #mediaWarned = false;

  /** 图片后台队列（见 `#pump`）：**不在消息路径上**。 */
  #queue = [];

  #pumping = false;

  /** 文字行的写入队列（异步串行；见 `#append` 的注释 —— 网络盘不能同步写）。 */
  #writeQueue = [];

  #writing = false;

  /** 归档盘当前可用吗（缓存；写失败会重新探）。 */
  #storageReady = false;

  /** 落进本地暂存的条数（面板/日志用）。 */
  #spooled = 0;

  /** 同类告警只报一次。 */
  #warned = {};

  /** 本地暂存根目录（归档盘不可用时的落地处；见构造函数注释）。 */
  #spoolRoot = '';

  /** "这一天这一小时写哪个档"的缓存（`日文件夹|HH` → 档名）；清理后要清空。 */
  #hourFileCache = new Map();

  #spoolHourCache = new Map();

  /** 最近一次真实写入落在哪个档 —— 定时刷新摘要时用它（见 `refreshCurrentSummary`）。 */
  #hourFileOfLastWrite = '';

  /**
   * **时钟异常守卫**（2026-10-11 真实事故后加的）：
   *
   * 那天这台机器的系统时钟跳到过 **2003 年**。归档里"收到"的消息用的是**事件自带时间戳**
   * （NapCat 给的 `time`，正常），所以没事；而"发出去"的消息只能用 `Date.now()` ——
   * 于是那几分钟的回复被写进了 `2003-10-11.jsonl`，等时钟回到 2026，
   * 滚动清理看到"2003 的那天早该删了"，**把它整档删掉**（日志实证：
   * `[归档] 滚动清理：删掉 2003-10-11`）。用户要的是"完整记忆"，这种静默丢失不能留。
   *
   * 判据（**只挡"往回跳"**）：新算出来的日期比"上次已知的好日期"**早一天以上**，
   * 就认定时钟异常 → 仍按**上次那个好日期**归档，打上 `clockSuspect` 标记 + 告警一次。
   * 往**前**跳不动手：那和"机器人停机几天"无法区分，而且未来日期的档不会被清理（不会丢数据）。
   */
  #lastGoodDay = '';

  #clockWarnedFor = '';

  /**
   * **`消息id → {who, text}` 索引**（2026-10-11 加，解决"引用读不出来"）。
   *
   * 用户担心得很对：原来的引用段只存了 `{type:'reply', id:'12345'}` ——
   * 以后翻到这条，**完全看不出当时引用的是哪句话**。现在：
   *   ① 归档**每条消息都存下自己的 `id`**（`message_id`，我们发出去的也一样）；
   *   ② 遇到引用段 → 先用这个内存索引查（**同一进程里的近期消息**，最快）；
   *   ③ 查不到就**回归档里翻**（`#lookupQuoted`，扫最近几天的档找那个 id）——
   *      覆盖"引用的是上次重启前说的话"这种情况；
   *   ④ 把查到的原文写进段里（`quote:{who,text}`），并让 `segmentsToText` 带上它 →
   *      **被引用的内容也进了可搜索的正文**，以后按关键词/按时间都能翻到。
   */
  #idIndex = new Map();

  /** 记一条 id（有上限，别无限长）。 */
  #rememberId(id, who, text) {
    const key = String(id ?? '');
    if (!key) return;
    this.#idIndex.set(key, { who: String(who ?? ''), text: String(text ?? '').slice(0, 300), at: Date.now() });
    if (this.#idIndex.size > 2000) {
      // 简单地砍最早的一批（Map 保序）
      for (const k of [...this.#idIndex.keys()].slice(0, 500)) this.#idIndex.delete(k);
    }
  }

  /** 回归档里找一个消息 id 对应的那句话（内存索引没有时用；扫最近几天，找不到给 null）。 */
  #lookupQuoted(id) {
    const key = String(id ?? '');
    if (!key) return null;
    const today = dayKey(Date.now(), this.tz);
    for (let i = 0; i < Math.max(1, this.recallDays); i += 1) {
      const day = shiftDay(today, -i);
      const hourDir = join(this.dir, dayFolderName(day), '记忆');
      let files = [];
      try {
        files = readdirSync(hourDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        let raw = '';
        try {
          raw = readFileSync(join(hourDir, f), 'utf8');
        } catch {
          continue;
        }
        for (const line of raw.split('\n')) {
          if (!line.includes(key)) continue; // 便宜的预筛：不含这个 id 的行直接跳过
          try {
            const r = JSON.parse(line);
            if (String(r.id ?? '') === key) {
              return { who: r.dir === 'out' ? '小笛' : r.sender?.nickname || r.sender?.id || '', text: String(r.text ?? '') };
            }
          } catch {
            /* 坏行跳过 */
          }
        }
      }
    }
    return null;
  }

  /** 归一一个 `at`：必要时换成"上次已知的好日期"，返回 `{day, suspect}`。 */
  #normalizeDay(at) {
    const day = dayKey(at, this.tz);
    /**
     * ⚠️ **用户会故意把时钟改到过去**（2026-10-11 他说的：玩 ARG 需要）。
     * `clockGuard: true`（默认）：这段改写**不算"错"**，但归档要继续可用 ——
     * 把日期挂在"上次那个正常日"上（`clockSuspect:true` 标记），这样
     * ① 消息不会散进 `2003-…jsonl` 那种档里（也就不会被滚动清理误删）；
     * ② 这 7 天的窗口照常连得上。如果就想让归档跟着假时钟走，把它设成 false。
     */
    if (this.clockGuard === false) {
      if (!this.#lastGoodDay || day > this.#lastGoodDay) this.#lastGoodDay = day;
      return { day, suspect: false };
    }
    const prev = this.#lastGoodDay;
    const suspect = Boolean(prev) && day < shiftDay(prev, -1);
    if (suspect) {
      if (this.#clockWarnedFor !== day) {
        this.#clockWarnedFor = day;
        this.log.warn?.(
          `[归档] 系统时钟像是往回跳了：这次算出 ${day}，而上次还在 ${prev} —— ` +
            `这条按 ${prev} 归档并标记 clockSuspect（**不丢消息**）；请核对系统时间`,
        );
      }
      return { day: prev, suspect: true };
    }
    if (!prev || day > prev) this.#lastGoodDay = day;
    return { day, suspect: false };
  }

  /**
   * @param {object} opts
   * @param {string} opts.dir 归档根目录（`logs/chat`）
   * @param {number} [opts.ttlDays] 保留天数；**0 = 永久保留**（2026-10-13 起用户的选择 ✓）
   * @param {number} [opts.recallDays] **查询默认往后看几天**（默认 7）。它和 ttlDays 是**两件事**：
   *   保留期管"删不删"，回忆窗口管"搜多远" —— 不拆开的话，改成永久保留会让每次搜索都扫全库 ✗
   * @param {boolean} [opts.saveMedia] 图片要不要落盘（关掉就只记 URL）
   * @param {number} [opts.maxMediaBytes] 单张上限
   * @param {number} [opts.maxDayMediaBytes] 每天图片总量上限
   * @param {number} [opts.maxTotalBytes] 整个归档上限（超了降级成只记文字）
   * @param {(url:string, opts?:object)=>Promise<Buffer>} [opts.fetchMedia] 取图（注入，便于自测；生产传 `fetchImageBytes`）
   */
  constructor({
    dir,
    mediaDir = '',
    ttlDays = 7,
    recallDays = 0,
    saveMedia = true,
    maxMediaBytes = 8 * 1024 * 1024,
    maxVideoBytes = 20 * 1024 * 1024,
    maxDayMediaBytes = 50 * 1024 * 1024,
    maxTotalBytes = 2 * 1024 * 1024 * 1024,
    clockGuard = true,
    spoolDir = '',
    fetchMedia = null,
    log = console,
    tz = 'Asia/Shanghai',
  } = {}) {
    this.dir = resolve(String(dir ?? 'logs/chat'));
    /**
     * **本地暂存目录**（2026-10-11 加，起因是用户要用 iSCSI 挂 NAS）：
     * 归档盘（尤其网络盘）**开机时可能还没挂上**、**中途会掉**。那期间的记录不丢，
     * 先写到这里（默认在 `<dir>-spool`，务必放在**本地盘**上），盘回来后自动搬回去。
     * ⚠️ 别把 `spoolDir` 也指到同一个网络盘上 —— 那就失去意义了。
     */
    this.#spoolRoot = resolve(String(spoolDir || `${this.dir}-spool`));
    /**
     * **图片可以单独放一个盘**（2026-10-11 用户说他有一块 4T 机械盘）。
     * 这是**故意分开的**：文字档极小（实测 0.18MB/天）放在系统盘永远在；
     * 图片大、且可能放在**会拔走的盘**上 —— 盘不在时丢的只是图，**对话原文一个字不少**。
     * 留空 = 跟随 `dir`（`<dir>/media`）。
     */
    this.mediaRoot = mediaDir ? resolve(String(mediaDir)) : join(this.dir, 'media');
    // ⚠️ 0 = 永久保留（**不能用 `|| 7`** ✗ 那会把 0 变成 7）
    this.ttlDays = Number(ttlDays) === 0 ? 0 : Math.max(1, Number(ttlDays) || 7);
    this.recallDays = Math.max(1, Number(recallDays) || (this.ttlDays > 0 ? this.ttlDays : 7));
    this.saveMedia = saveMedia !== false;
    this.maxMediaBytes = Math.max(0, Number(maxMediaBytes) || 0);
    /** 视频单独一套上限（默认 20MB）：短视频几 MB，长视频直接跳过，别把盘吃光。 */
    this.maxVideoBytes = Math.max(0, Number(maxVideoBytes) || 0);
    this.maxDayMediaBytes = Math.max(0, Number(maxDayMediaBytes) || 0);
    /**
     * **总容量守卫**（2026-10-11 按实测加的）：本机 C: 只剩 14.1GB，
     * 图片平均 1.77MB/张 —— 不加这道闸，长窗口迟早把系统盘吃满。
     * 超限后的行为是**降级**：继续记文字（那部分几乎不占地方），但**不再存图片**，并告警一次。
     */
    this.maxTotalBytes = Math.max(0, Number(maxTotalBytes) || 0);
    /** 时钟往回跳时是否把日期挂在"上次正常日"上（默认 true；设 false 就跟着假时钟走）。 */
    this.clockGuard = clockGuard !== false;
    this.fetchMedia = fetchMedia;
    this.log = log;
    this.tz = tz;
    this.lastPrune = null;
    this.#mediaDisabled = false;
    /**
     * ⚠️ **构造时不再"必须建成功"**（2026-10-11 改）：原来这里是裸的 `mkdirSync(this.dir)` ——
     * 目录建不出来（iSCSI 还没挂上、盘没插、盘符没分配）就**直接抛错**，
     * 而它是在 `startBot` 里调的 → **机器人整个起不来** ✗。
     * 现在只"尽力试一次"：失败就记下来，写入时走本地暂存（见 `#ensureStorage` / `#append`）。
     */
    try {
      mkdirSync(this.dir, { recursive: true });
      this.#storageReady = true;
    } catch (err) {
      this.#storageReady = false;
      this.log.warn?.(
        `[归档] 归档盘现在不可用（${err.message}）—— 机器人照常运行，记录先写本地暂存 ${this.#spoolRoot}`,
      );
    }
    try {
      mkdirSync(this.#spoolRoot, { recursive: true });
    } catch {
      /* 连暂存都建不出来就只能放弃归档了，但不影响机器人 */
    }
  }

  /**
   * 归档现在占多少（jsonl + 图片全算）。用于总容量守卫与面板展示。
   * ⚠️ `mediaRoot` 默认在 `dir` 里面（`<dir>/media`），这时**只走一遍**，
   * 否则会把同一批文件数两遍、守卫提前触发。
   */
  usedBytes() {
    let total = 0;
    const walk = (d) => {
      let names = [];
      try {
        names = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of names) {
        const full = join(d, e.name);
        try {
          if (e.isDirectory()) walk(full);
          else total += statSync(full).size;
        } catch {
          /* 单个文件读不到就算了 */
        }
      }
    };
    walk(this.dir);
    const mediaInside = this.mediaRoot.toLowerCase().startsWith(this.dir.toLowerCase());
    if (!mediaInside) walk(this.mediaRoot);
    return total;
  }

  /**
   * 解析"这一天这一小时"该写哪个档：
   *   · 已经有档（`13-59-07.jsonl` 或老的 `13.jsonl`）→ **沿用它**（保证"每小时一个档"）；
   *   · 没有 → 用**这条消息的时间**做档名（`hourFileName`）。
   * 结果**缓存**（`day|HH` → 文件名），免得每条消息都 readdir 一次。
   */
  #resolveHourFile(root, day, at, cache) {
    const dayFolder = dayFolderName(day);
    const hh = hourName(at);
    const key = `${dayFolder}|${hh}`;
    const cached = cache.get(key);
    if (cached) return cached;
    let found = '';
    try {
      const names = readdirSync(join(root, dayFolder, '记忆')).filter((f) => f.endsWith('.jsonl') && hourPrefixOf(f) === hh);
      if (names.length) found = names.sort()[0];
    } catch {
      /* 这一天还没写过东西 */
    }
    const name = found || hourFileName(at);
    cache.set(key, name);
    return name;
  }

  /**
   * **新版布局（用户 2026-10-11 指定的结构）**：
   * ```
   * 小笛记忆/2026.10.11/记忆/13-59-07.jsonl   ← 每小时一个追加档（档名=挂档那一刻的时分秒；没消息就不建）
   * 小笛记忆/2026.10.11/图片/<sha16>.jpg      ← 图片与那天放一起（按内容去重）
   * 小笛记忆/2026.10.11/视频/<sha16>.mp4      ← 视频单独一个子目录（体积大，单张有上限）
   * ```
   * 好处：人能直接翻；一个档坏了只损失那一小时；**第 8 天删第 1 天 = 删一个文件夹**。
   * `at` 用**消息自带的时间戳**算（不是本机 `Date.now()`），所以时钟被改也不影响归档的连续性。
   */
  fileFor(day, at = 0) {
    return join(this.dir, dayFolderName(day), '记忆', this.#resolveHourFile(this.dir, day, at, this.#hourFileCache));
  }
  /** 老版布局（`<dir>/YYYY-MM-DD.jsonl`）—— 只为兼容与迁移保留。 */
  legacyFileFor(day) {
    return join(this.dir, `${day}.jsonl`);
  }
  dayDirFor(day) {
    return join(this.dir, dayFolderName(day));
  }
  mediaDirFor(day, kind = 'image') {
    // 图片与视频分开放：`图片/` 与 `视频/`（用户 2026-10-11 说"图片、视频也要能找"）
    return join(this.mediaRoot, dayFolderName(day), kind === 'video' ? '视频' : '图片');
  }

  /**
   * 低层：**把一行排进写入队列**。
   *
   * ⚠️ **2026-10-11 改成异步队列，起因是用户的存储计划**：他以后要用 **iSCSI 挂 NAS 的网盘**
   * （现在先直连机械盘）。网络盘与本地盘有三个本质区别，同步写全都接不住：
   *   ① **开机时可能还没挂上**（iSCSI 要先登录 initiator）→ 目录不存在；
   *   ② **中途会掉**（网络抖、NAS 重启）→ 写入抛错；
   *   ③ **挂了会卡**（I/O 挂住直到超时）→ `appendFileSync` 会把**整个事件循环**堵死，
   *      机器人**完全不回话**（这比丢几行记录严重得多）。
   * 所以：写入走**异步 + 串行队列**（卡也只卡这一条 promise，不卡机器人），
   * 目标不可用时**落到本地暂存 `spoolDir`**，等盘回来再自动搬进去（见 `sweepSpool`）。
   */
  #append(entry) {
    this.#writeQueue.push({ entry, line: JSON.stringify(entry) });
    this.#pumpWrites();
    return true;
  }

  /** 真实写入：优先归档盘，不可用就落本地暂存；**永远不抛**。 */
  async #writeLine(entry, line) {
    const target = (await this.#ensureStorage())
      ? this.fileFor(entry.day, entry.at)
      : this.#spoolFileFor(entry.day, entry.at);
    /**
     * **换小时了** → 给上一个档补一次摘要（用户要的"档里有摘要"）。
     * 只在真换档时做，写路径上不会每来一条消息都算一遍。
     */
    if (this.#hourFileOfLastWrite && this.#hourFileOfLastWrite !== target && !target.startsWith(this.#spoolRoot)) {
      const prev = this.#hourFileOfLastWrite;
      this.#hourFileOfLastWrite = '';
      this.summarizeFile(prev);
    }
    try {
      await fsp.mkdir(dirname(target), { recursive: true });
      await fsp.appendFile(target, `${line}\n`, 'utf8');
      // 记下"最近写到哪个档" → 换小时/定时刷新时给它补摘要（见 summarizeFile）
      if (!target.startsWith(this.#spoolRoot)) this.#hourFileOfLastWrite = target;
      if (target.startsWith(this.#spoolRoot)) this.#spooled += 1;
      return true;
    } catch (err) {
      // 归档盘写到一半失败（典型：iSCSI 掉了）→ 再试一次本地暂存，别再抛
      const spooled = this.#spoolFileFor(entry.day, entry.at);
      try {
        await fsp.mkdir(dirname(spooled), { recursive: true });
        await fsp.appendFile(spooled, `${line}\n`, 'utf8');
        this.#spooled += 1;
        this.#warnOnce('spool', `[归档] ${this.dir} 写不进去（${err.message}）—— 已改存本地暂存 ${this.#spoolRoot}`);
      } catch (err2) {
        this.#warnOnce('fail', `[归档] 连本地暂存也写不进去（${err2.message}）—— 这条记录丢了（不影响聊天）`);
      }
      return false;
    }
  }

  /** 串行抽干写入队列（并发写同一个文件会把行搅在一起）。 */
  async #pumpWrites() {
    if (this.#writing) return;
    this.#writing = true;
    try {
      while (this.#writeQueue.length) {
        const job = this.#writeQueue.shift();
        // eslint-disable-next-line no-await-in-loop
        await this.#writeLine(job.entry, job.line);
      }
    } finally {
      this.#writing = false;
    }
  }

  /**
   * 归档盘现在能用吗？**建目录成功 = 能用**（iSCSI 没挂上/盘没插时这里就会失败）。
   * 结果缓存，但每次"写失败"会重新探一次 —— 盘回来能自动恢复。
   */
  async #ensureStorage() {
    if (this.#storageReady) return true;
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      if (!this.#storageReady) {
        this.#storageReady = true;
        this.#warnOnce('back', `[归档] 归档盘就绪：${this.dir}`);
        // 盘刚回来 → 把暂存的搬进去
        this.sweepSpool().catch(() => {});
      }
      return true;
    } catch (err) {
      this.#storageReady = false;
      this.#warnOnce('noready', `[归档] 归档盘不可用（${err.message}）—— 先写本地暂存，等它回来自动搬过去`);
      return false;
    }
  }

  /** 暂存里的落点：与归档**同一套形状**（日文件夹/记忆/小时档，档名同样精确到秒）。 */
  #spoolFileFor(day, at = 0) {
    return join(this.#spoolRoot, dayFolderName(day), '记忆', this.#resolveHourFile(this.#spoolRoot, day, at, this.#spoolHourCache));
  }

  /**
   * **给某个小时档写摘要**（侧车文件 `<小时档名>.摘要.txt`，挨着原档放）。
   *
   * ⚠️ 为什么不直接写在档的**第一行**：档是**追加写**的（崩了最多丢最后一条），
   * 往开头插一行就得整档重写 —— 那是"为了好看牺牲可靠性"。侧车文件两全：
   * 原档照旧追加、摘要单独一个文件，而且**随时可以重算覆盖**（幂等）。
   * 读的时候优先用侧车；侧车还没写（比如就是当前这一小时）就**现算**，所以永远不缺口。
   */
  summarizeFile(file) {
    try {
      if (!existsSync(file)) return '';
      const rows = readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const text = summarizeHour(rows);
      if (text) {
        const side = `${file}.摘要.txt`;
        try {
          writeFileSync(side, `${text}\n`, 'utf8');
        } catch {
          /* 摘要写不进去不影响归档 */
        }
        this.#hourFileOfLastWrite = file;
      }
      return text;
    } catch {
      return '';
    }
  }

  /** 给**当前这一小时**的档（重新）写一次摘要 —— 挂到定时清理上，每 10 分钟刷新。 */
  refreshCurrentSummary() {
    if (this.#hourFileOfLastWrite) this.summarizeFile(this.#hourFileOfLastWrite);
  }

  /**
   * **列出某段时间里每个小时档的摘要**（给"跨度大且分散"的浏览用）。
   * 侧车有就用侧车（快）；没有就现算（当前这一小时通常还没侧车）。
   * @returns {Array<{day:string, file:string, summary:string, at:number}>} 新的在前
   */
  summaries({ from = 0, to = 0, days = this.recallDays, now = Date.now() } = {}) {
    const out = [];
    const today = dayKey(now, this.tz);
    const dayList = [];
    if (from || to) {
      const first = dayKey(from || to, this.tz);
      const last = dayKey(to || from, this.tz);
      for (let d = first; d <= last && dayList.length < 400; d = shiftDay(d, 1)) dayList.push(d);
    } else {
      for (let i = 0; i < Math.max(1, Number(days) || this.ttlDays); i += 1) dayList.push(shiftDay(today, -i));
    }
    for (const day of dayList) {
      const hourDir = join(this.dir, dayFolderName(day), '记忆');
      let files = [];
      try {
        files = readdirSync(hourDir)
          .filter((f) => f.endsWith('.jsonl'))
          .sort()
          .reverse();
      } catch {
        continue;
      }
      for (const f of files) {
        const full = join(hourDir, f);
        const side = `${full}.摘要.txt`;
        let summary = '';
        try {
          if (existsSync(side)) summary = readFileSync(side, 'utf8').trim();
        } catch {
          /* 读不到就现算 */
        }
        if (!summary) summary = summarizeHour(
          readFileSync(full, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean),
        );
        if (!summary) continue;
        // 用档名里的 `<HH>-<mm>-<ss>` 还原这个档的起点时间
        const m = f.match(/^(\d{2})-(\d{2})-(\d{2})\.jsonl$/);
        const [y, mo, d2] = dayKeyFromFolder(day).split('-').map(Number);
        const at = m ? new Date(y, mo - 1, d2, Number(m[1]), Number(m[2]), Number(m[3])).getTime() : 0;
        if ((from || to) && !(at >= (from || 0) && at <= (to || Infinity))) continue;
        out.push({ day, file: full, summary, at });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * **把本地暂存搬进归档盘**（盘回来后自动调用；`prune()` 里也会顺手调一次）。
   * 顺序：先 append 到归档（成功才删暂存）—— 宁可重复也**不许先删后写**。
   */
  async sweepSpool() {
    if (!(await this.#ensureStorage())) return { moved: 0 };
    let dayDirs = [];
    try {
      dayDirs = readdirSync(this.#spoolRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && isDayFolder(e.name));
      // 老版暂存（`<spool>/YYYY-MM-DD.jsonl`）也认
      const legacy = readdirSync(this.#spoolRoot).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
      for (const f of legacy) dayDirs.push({ name: f.replace('.jsonl', ''), legacyFile: f });
    } catch {
      return { moved: 0 };
    }
    let moved = 0;
    for (const entry of dayDirs) {
      try {
        if (entry.legacyFile) {
          const full = join(this.#spoolRoot, entry.legacyFile);
          const lines = readFileSync(full, 'utf8').split('\n').filter(Boolean);
          for (const l of lines) {
            let r = null;
            try {
              r = JSON.parse(l);
            } catch {
              continue;
            }
            // eslint-disable-next-line no-await-in-loop
            await fsp.mkdir(dirname(this.fileFor(r.day ?? entry.name, r.at)), { recursive: true });
            // eslint-disable-next-line no-await-in-loop
            await fsp.appendFile(this.fileFor(r.day ?? entry.name, r.at), `${l}\n`, 'utf8');
            moved += 1;
          }
          // eslint-disable-next-line no-await-in-loop
          await fsp.rm(full, { force: true });
          continue;
        }
        const hourDir = join(this.#spoolRoot, entry.name, '记忆');
        const hours = readdirSync(hourDir).filter((f) => f.endsWith('.jsonl'));
        for (const h of hours) {
          const full = join(hourDir, h);
          const lines = readFileSync(full, 'utf8').split('\n').filter(Boolean);
          const target = join(this.dir, entry.name, '记忆', h);
          if (lines.length) {
            // eslint-disable-next-line no-await-in-loop
            await fsp.mkdir(dirname(target), { recursive: true });
            // eslint-disable-next-line no-await-in-loop
            await fsp.appendFile(target, `${lines.join('\n')}\n`, 'utf8');
            moved += lines.length;
          }
          // eslint-disable-next-line no-await-in-loop
          await fsp.rm(full, { force: true });
        }
        // 暂存里这一天搬空了就把空目录收掉
        try {
          if (readdirSync(hourDir).length === 0) rmSync(join(this.#spoolRoot, entry.name), { recursive: true, force: true });
        } catch {
          /* 忽略 */
        }
      } catch (err) {
        this.#warnOnce('sweep', `[归档] 暂存搬运失败（下次再试）：${err.message}`);
        break;
      }
    }
    if (moved) this.log.info?.(`[归档] 已把本地暂存的 ${moved} 条记录搬回归档盘`);
    return { moved };
  }

  /** 同一类告警只说一次（网络盘掉线时会反复失败，刷屏反而把有用的日志淹了）。 */
  #warnOnce(kind, msg) {
    if (this.#warned[kind]) return;
    this.#warned[kind] = true;
    this.log.warn?.(msg);
  }

  /** 归档盘 / 本地暂存 的当前状态（面板、排查用）。 */
  storageState() {
    return {
      dir: this.dir,
      ready: this.#storageReady,
      spoolDir: this.#spoolRoot,
      pending: this.#writeQueue.length,
      spooled: this.#spooled,
    };
  }

  /**
   * 把这一批图片存下来（sha 去重 + 单张/每日/总量上限），返回 media 列表。
   *
   * ⚠️ **盘不在时不许报错、不许拖慢**：图片可能放在一块**会拔走的机械盘**上（用户那块 4T）。
   * 目录建不出来就告警一次并跳过（丢的只是图，文字档已经写完了）。
   */
  async #saveMedia(day, segments) {
    if (!this.saveMedia || !this.fetchMedia) return [];
    // 总容量守卫：超了就一直只记文字（直到清理把空间腾出来）
    if (this.#mediaDisabled) return [{ skipped: '归档总量已达上限，本次只记文字' }];
    if (this.maxTotalBytes && this.usedBytes() > this.maxTotalBytes) {
      this.#mediaDisabled = true;
      this.log.warn?.(
        `[归档] 总量已超过 ${Math.round(this.maxTotalBytes / 1073741824)}GB —— **从这条起只记文字、不再存图片/视频**` +
          `（把 chatArchive.dir 挪到 D: 或调大 maxTotalBytes 可解除）`,
      );
      return [{ skipped: '归档总量已达上限，本次只记文字' }];
    }
    /**
     * ⚠️ **视频也要能找**（用户 2026-10-11 说「图片、视频也要能找」）：
     * 图片照旧（`s.url`）；视频取 `s.file` —— 它有时是 **URL**（QQ 的 CDN），有时是 NapCat 那边的
     * **本地路径**（那种我们取不到，只能把引用记下来）。所以只对 `http(s)` 的去下载。
     * 视频单独一套上限（`maxVideoBytes`，默认 20MB）：短视频通常几 MB，长视频直接跳过。
     */
    const jobs = [];
    for (const s of segments) {
      /**
       * ⚠️ **本地文件也要归档**（2026-10-14 加，为 TG）：
       * TG 的图没有公网 URL ✗，传输层已经下到本地并写成 file://路径 ✓ ——
       * 那就**直接复制**它，别再走网络（也避免图片过期失效 ✗）。
       */
      const localOf = (x) => (typeof x?.file === 'string' && x.file.startsWith('file://') ? x.file.replace(/^file:\/\//, '') : '');
      if (s.type === 'image' && localOf(s)) jobs.push({ kind: 'image', localFile: localOf(s), cap: this.maxMediaBytes });
      else if (s.type === 'image' && s.url) jobs.push({ kind: 'image', url: s.url, cap: this.maxMediaBytes });
      else if (s.type === 'video' && /^https?:/i.test(String(s.file ?? ''))) jobs.push({ kind: 'video', url: s.file, cap: this.maxVideoBytes });
    }
    if (!jobs.length) return [];
    const saved = [];
    const seen = new Set();
    for (const job of jobs) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      const dir = this.mediaDirFor(day, job.kind);
      // 盘在不在？——建目录失败就是不在（外接盘没插 / 盘符还没分配）
      try {
        mkdirSync(dir, { recursive: true });
        this.#mediaWarned = false;
      } catch (err) {
        if (!this.#mediaWarned) {
          this.#mediaWarned = true;
          this.log.warn?.(`[归档] 媒体目录不可用（${dir}：${err.message}）—— **只记文字，图/视频跳过**，不影响聊天`);
        }
        saved.push({ skipped: '媒体目录不可用（盘没插？）' });
        continue;
      }
      let used = 0;
      try {
        for (const f of readdirSync(dir)) {
          try {
            used += statSync(join(dir, f)).size;
          } catch {
            /* 单个文件读不到就算了 */
          }
        }
      } catch {
        /* 目录不存在等 */
      }
      try {
        const buf = job.localFile
          ? readFileSync(job.localFile)
          : await this.fetchMedia(job.url, { timeoutMs: job.kind === 'video' ? 60000 : 30000, maxBytes: job.cap || undefined });
        if (!buf?.length) continue;
        if (job.cap && buf.length > job.cap) {
          saved.push({ kind: job.kind, skipped: `超过单个上限 ${Math.round(job.cap / 1048576)}MB`, bytes: buf.length });
          continue;
        }
        if (this.maxDayMediaBytes && used + buf.length > this.maxDayMediaBytes) {
          saved.push({ kind: job.kind, skipped: `超过当天媒体总量上限 ${Math.round(this.maxDayMediaBytes / 1048576)}MB` });
          continue;
        }
        const sha = createHash('sha256').update(buf).digest('hex');
        const ext = job.kind === 'video' ? extFromUrl(job.url, '', 'mp4') : extFromUrl(job.url);
        const name = `${sha.slice(0, 16)}.${ext}`;
        const full = join(dir, name);
        if (!existsSync(full)) {
          writeFileSync(full, buf);
          used += buf.length;
        }
        // 记**绝对路径**（媒体可能与文字档不在同一个盘上，相对路径会说不清）+ `kind` 便于区分怎么发
        saved.push({ kind: job.kind, sha, file: full, bytes: buf.length });
      } catch (err) {
        saved.push({ kind: job.kind, skipped: `下载失败：${err.message}` });
      }
    }
    return saved;
  }

  /**
   * **记一条收到的消息**（每条进来的消息都应调它，包括我们不理的）。
   *
   * ⚠️ **零延迟保证**（2026-10-11 定的）：文字行**立刻**写；图片走**后台队列**。
   * 原因是图片要下载（最多 30 秒）+ 可能要唤醒一块机械盘 —— 这两件事**绝不允许挡住回复**。
   * 图片存好后会**补记一条 sidecar 行**（`dir:'media'`，带同一个 `at`+`key`），`recent()` 会自动合并。
   */
  async recordIncoming({ scope, key, sender, message, at = Date.now(), selfId = '', id = '', extra = {} } = {}) {
    /**
     * ⚠️ **收到的消息不过"时钟守卫"**（2026-10-11 被自测抓到的边界）：
     * 它的 `at` 来自**事件自带的时间戳**（NapCat 给的，可靠），不是本机 `Date.now()`。
     * 守卫是给"本机时钟被改"准备的 —— 用在这里会**误伤补录/回放旧数据**
     * （我在测试里把三天历史写在一个会话里，第二条就被当"时钟往回跳"改掉了日期 ✗）。
     * 真实事故里那个 2003 的档里**也只有发出去的消息**，与这条规则一致。
     */
    const day = dayKey(at, this.tz);
    const suspect = false;
    const segments = normalizeSegments(message, selfId);
    /**
     * ⚠️ **把引用解析成"自包含"**（2026-10-11，用户的担心）：
     * 引用段原来只有 id，翻记录时看不出引的是什么。这里趁**当时**把它查出来存进段里：
     * 先查内存索引（同进程近期消息），再回归档里找（引用的是重启前的话也能找到）。
     */
    for (const s of segments) {
      if (s.type !== 'reply' || !s.id) continue;
      const hit = this.#idIndex.get(String(s.id)) ?? this.#lookupQuoted(s.id);
      s.quote = hit ? { who: hit.who, text: String(hit.text).slice(0, 300) } : null;
    }
    const text = segmentsToText(segments);
    const ok = this.#append({
      at,
      day,
      dir: 'in',
      scope: String(scope ?? ''),
      key: String(key ?? ''),
      // 存下这条消息自己的 id → 以后别人引用它时能查回来
      ...(id ? { id: String(id) } : {}),
      sender: { id: String(sender?.id ?? ''), nickname: String(sender?.nickname ?? '') },
      text: text.slice(0, 4000),
      segments,
      ...(suspect ? { clockSuspect: true } : {}),
      ...extra,
    });
    this.#rememberId(id, sender?.nickname || sender?.id || '', text);
    // 有图/视频就进后台队列（**视频也算**：用户要"图片、视频也要能找"）
    if (segments.some((s) => (s.type === 'image' && s.url) || (s.type === 'video' && /^https?:/i.test(String(s.file ?? ''))))) {
      this.#queue.push({ day, at, key: String(key ?? ''), segments });
      this.#pump();
    }
    return ok;
  }

  /** 记一条**发出去的**消息（纯文本/富消息段都可以）。 */
  recordOutgoing({ target, segments, text, at = Date.now(), id = '', extra = {} } = {}) {
    // ⚠️ 这里也必须过 `#normalizeDay` —— 2026-10-11 那次"时钟被改到 2003"的事故里，
    //    **只有发出去的消息**用了 `Date.now()`（收到的用事件时间戳），所以正是这条路把档写进了 2003。
    const { day, suspect } = this.#normalizeDay(at);
    const norm = Array.isArray(segments) && segments.length ? normalizeSegments(segments) : [];
    const line = {
      at,
      day,
      dir: 'out',
      scope: String(target?.type ?? ''),
      key: `${target?.type ?? ''}:${target?.id ?? ''}`,
      // 我们也存 id：这样"别人引用小笛说的话"也能解析出原文
      ...(id ? { id: String(id) } : {}),
      text: String(text ?? segmentsToText(norm)).slice(0, 4000),
      ...(norm.length ? { segments: norm } : {}),
      ...(suspect ? { clockSuspect: true } : {}),
      ...extra,
    };
    this.#rememberId(id, '小笛', line.text);
    return this.#append(line);
  }

  /**
   * 后台串行处理图片队列（**不在消息路径上**）。
   * 串行而不是并发：机械盘同时写十几个文件会抖得厉害；一天几十张图这点量慢慢来就够。
   */
  async #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#queue.length) {
        const job = this.#queue.shift();
        const media = await this.#saveMedia(job.day, job.segments);
        if (media.length) {
          // sidecar 行：`recent()` 会按 (at,key) 合并回那条消息
          this.#append({ at: job.at, day: job.day, dir: 'media', key: job.key, media });
        }
      }
    } catch (err) {
      this.log.warn?.(`[归档] 图片后台任务出错（不影响聊天）：${err.message}`);
    } finally {
      this.#pumping = false;
    }
  }

  /** 等后台队列跑完（文字写入队列 + 图片队列）——给自测和退出前用；生产不需要等。 */
  async flush({ timeoutMs = 30000 } = {}) {
    const t0 = Date.now();
    while ((this.#writing || this.#writeQueue.length || this.#pumping || this.#queue.length) && Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return { pending: this.#queue.length + this.#writeQueue.length, pumping: this.#pumping || this.#writing };
  }

  /**
   * 读最近 `days` 天的行（新的在前）；也可以用 `from/to` 指定**时间段**
   * （用户要的"按时间找"就走这条：只读落在窗口里的**那几天**的档）。
   * 坏了行跳过，不让一行坏数据毁掉整段历史。
   * ⚠️ **本地暂存也算数据源**（2026-10-11）：归档盘不在时记录落在 spool 里，
   * 如果读的时候不看它，那段时间的对话就"查不到"（人以为丢了）。
   */
  recent({ days = this.recallDays, now = Date.now(), from = 0, to = 0 } = {}) {
    const today = dayKey(now, this.tz);
    const rows = [];
    /** 读一个"根目录"下某一天的档（新结构的小时档 + 老结构的一天一档都认）。 */
    const readDay = (root, day) => {
      const hourDir = join(root, dayFolderName(day), '记忆');
      let files = [];
      try {
        files = readdirSync(hourDir).filter((f) => f.endsWith('.jsonl')).sort().reverse(); // 新的小时在前
      } catch {
        /* 那天没有新结构 */
      }
      const legacy = join(root, `${day}.jsonl`);
      if (existsSync(legacy)) files.push(`../${day}.jsonl`); // 老结构（迁移前的残留）
      for (const f of files) {
        const full = f.startsWith('../') ? join(root, f.slice(3)) : join(hourDir, f);
        let raw = '';
        try {
          raw = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const lines = raw.split('\n').filter(Boolean);
        for (let j = lines.length - 1; j >= 0; j -= 1) {
          try {
            const r = JSON.parse(lines[j]);
            // 有时间段就按行自己的 `at` 过滤（"今早"就不会把凌晨和晚上的一起捞出来）
            if ((from || to) && !(Number(r.at) >= (from || 0) && Number(r.at) <= (to || Infinity))) continue;
            rows.push(r);
          } catch {
            /* 半行/坏行跳过 */
          }
        }
      }
    };
    /**
     * 只读**落在窗口里的那些天**（这是目录结构带来的好处：按时间找不用扫全部 168 个档）。
     * 没给窗口就按"最近 days 天"。
     */
    const dayList = [];
    if (from || to) {
      const first = dayKey(from || to, this.tz);
      const last = dayKey(to || from, this.tz);
      for (let d = first; d <= last && dayList.length < 400; d = shiftDay(d, 1)) dayList.push(d);
    } else {
      for (let i = 0; i < Math.max(1, Number(days) || this.ttlDays); i += 1) dayList.push(shiftDay(today, -i));
    }
    for (const day of dayList) {
      readDay(this.dir, day);
      // ⚠️ **本地暂存也算数据源**：归档盘不在时记录落在 spool 里，
      // 不读它就等于"那段时间查不到"（人以为丢了）。
      if (this.#spoolRoot !== this.dir) readDay(this.#spoolRoot, day);
    }
    // 合并 sidecar（图片后补的那条）→ 挂回原消息，别让它们当成两条消息
    const mediaByKey = new Map();
    for (const r of rows) {
      if (r.dir !== 'media') continue;
      const k = `${r.at}|${r.key}`;
      mediaByKey.set(k, [...(mediaByKey.get(k) ?? []), ...(r.media ?? [])]);
    }
    return rows
      .filter((r) => r.dir !== 'media')
      .map((r) => {
        const extra = mediaByKey.get(`${r.at}|${r.key}`);
        return extra ? { ...r, media: [...(r.media ?? []), ...extra] } : r;
      });
  }

  /**
   * **搜聊天记录**（给 `recall_chat` 工具用）。
   *   · `query`：子串匹配（大小写不敏感）；**可以只给时间段不给词**（"昨晚聊了啥"那种纯浏览）；
   *   · `from/to`：时间段（毫秒闭区间）——"今早/昨晚/昨天"这些由 `parseTimeWindow()` 先解析好；
   *   · `key`：限定某个会话（`private:xxx` / `group:xxx`）。
   * 命中按时间倒序（新的在前）。
   */
  search({ query = '', days = this.recallDays, limit = 20, key = '', dir = '', from = 0, to = 0 } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    const k = String(key ?? '').trim();
    const d = String(dir ?? '').trim();
    const out = [];
    for (const row of this.recent({ days, from, to })) {
      if (k && row.key !== k) continue;
      if (d && row.dir !== d) continue;
      if (q && !String(row.text ?? '').toLowerCase().includes(q)) continue;
      out.push({
        at: row.at,
        day: row.day,
        dir: row.dir,
        key: row.key,
        who: row.dir === 'out' ? '小笛' : row.sender?.nickname || row.sender?.id || '',
        text: row.text,
        hasImage: (row.segments ?? []).some((s) => s.type === 'image'),
        media: row.media ?? [],
      });
      if (out.length >= Math.max(1, Number(limit) || 20)) break;
    }
    return out;
  }

  /** 归档现状（给面板/日志看）：日文件夹、小时档、占用、暂存情况。 */
  stats() {
    let dayFolders = [];
    let legacyFiles = [];
    try {
      for (const e of readdirSync(this.dir, { withFileTypes: true })) {
        if (e.isDirectory() && isDayFolder(e.name)) dayFolders.push(e.name);
        else if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(e.name)) legacyFiles.push(e.name.replace('.jsonl', ''));
      }
    } catch {
      /* 目录还没有（或盘不在） */
    }
    dayFolders.sort();
    let bytes = 0;
    let hours = 0;
    for (const d of dayFolders) {
      const hourDir = join(this.dir, d, '记忆');
      try {
        for (const f of readdirSync(hourDir)) {
          if (!f.endsWith('.jsonl')) continue;
          hours += 1;
          bytes += statSync(join(hourDir, f)).size;
        }
      } catch {
        /* 那天没写东西 */
      }
    }
    let spoolDays = [];
    try {
      spoolDays = readdirSync(this.#spoolRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && isDayFolder(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      /* 没有暂存 */
    }
    return {
      days: dayFolders,
      files: hours,
      hours,
      bytes,
      legacyDays: legacyFiles,
      ttlDays: this.ttlDays,
    recallDays: this.recallDays,
      ready: this.#storageReady,
      spoolDir: this.#spoolRoot,
      spoolDays,
    };
  }

  /**
   * **滚动清理**：删掉超期那一天的**整个文件夹**（`小笛记忆/2026.10.04/` 一刀切掉），
   * 老结构残留的 `<dir>/YYYY-MM-DD.jsonl` 也一并清掉。
   * 启动时 + 每隔一段时间调一次即可（很便宜：只读目录）。
   * @returns {{drop:string[], cutoff:string, odd:string[]}}
   */
  prune({ now = Date.now() } = {}) {
    const today = dayKey(now, this.tz);
    // 顺手把本地暂存搬进归档盘（盘回来了就会搬走；盘不在时这里直接返回）
    this.sweepSpool().catch(() => {});
    let entries = [];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return { drop: [], cutoff: this.ttlDays > 0 ? shiftDay(today, -(this.ttlDays - 1)) : '（永久保留，不清理）', odd: [] };
    }
    // 认得出的日期（新结构=文件夹，老结构=文件）；认不出的一律不碰
    const dayNames = entries
      .filter((e) => isDayFolder(e.name))
      .map((e) => e.name);
    const legacyDayNames = entries
      .filter((e) => e.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(e.name))
      .map((e) => e.name.replace('.jsonl', ''));
    const { drop, cutoff, odd } = prunePlan([...new Set([...dayNames, ...legacyDayNames])], today, this.ttlDays);
    const done = [];
    for (const day of drop) {
      const iso = dayKeyFromFolder(day);
      try {
        rmSync(this.dayDirFor(iso), { recursive: true, force: true }); // 整个日文件夹（含记忆/图片）
        rmSync(this.legacyFileFor(iso), { force: true }); // 老结构残留
        rmSync(join(this.mediaRoot, dayFolderName(iso)), { recursive: true, force: true }); // 图片另存盘时
        done.push(day);
      } catch (err) {
        this.log.warn?.(`[归档] 清理 ${day} 失败：${err.message}`);
      }
    }
    // 删过的东西可能还在"这一小时写哪个档"的缓存里（否则会把刚删的档又造出来）
    if (done.length) {
      this.#hourFileCache.clear();
      this.#spoolHourCache.clear();
    }
    if (odd?.length) {
      this.log.warn?.(
        `[归档] 有 ${odd.length} 个"不像话的日期"档被**保留**（${odd.join('/')}）—— ` +
          `多半是系统时钟被改过（改回去玩 ARG 那种）。没有自动删，你看着处理；` +
          `想清掉就直接删这几个`,
      );
    }
    this.lastPrune = { at: now, cutoff, dropped: done, odd: odd ?? [] };
    if (done.length) this.log.info?.(`[归档] 滚动清理：删掉 ${done.join(' / ')}（保留 ${cutoff} 起、共 ${this.ttlDays} 天）`);
    return { drop: done, cutoff, odd: odd ?? [] };
  }

  /**
   * **把老结构（一天一个 `<dir>/YYYY-MM-DD.jsonl`）搬进新结构**
   *（`<dir>/YYYY.MM.DD/记忆/<HH>.jsonl`），按每行自己的 `at` 归小时。
   *
   * 为什么要有它：2026-10-11 用户改了布局，而**当天已经有真实记录**（56 行）——
   * 直接换布局会把它们"弄丢"（读不到）。搬完把老文件改名成 `.migrated`（**不删**，
   * 可回溯，且 `recent()` 只认 `.jsonl` 所以不会再被读进来）。
   */
  async migrateLegacy({ dryRun = false } = {}) {
    let names = [];
    try {
      names = readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    } catch {
      return { moved: 0, files: [] };
    }
    let moved = 0;
    const doneFiles = [];
    for (const f of names) {
      const day = f.replace('.jsonl', '');
      const full = join(this.dir, f);
      let lines = [];
      try {
        lines = readFileSync(full, 'utf8').split('\n').filter(Boolean);
      } catch {
        continue;
      }
      if (dryRun) {
        moved += lines.length;
        doneFiles.push({ file: f, lines: lines.length });
        continue;
      }
      const byHour = new Map();
      for (const l of lines) {
        let at = 0;
        try {
          at = Number(JSON.parse(l).at) || 0;
        } catch {
          at = 0;
        }
        const h = hourName(at || Date.now());
        byHour.set(h, [...(byHour.get(h) ?? []), l]);
      }
      for (const [h, ls] of byHour) {
        // 档名用**这一小时第一条消息的时间**（与正常运行时的命名规则一致）
        let firstAt = 0;
        try {
          firstAt = Number(JSON.parse(ls[0]).at) || 0;
        } catch {
          firstAt = 0;
        }
        const target = join(this.dir, dayFolderName(day), '记忆', hourFileName(firstAt || Date.now()));
        try {
          await fsp.mkdir(dirname(target), { recursive: true });
          await fsp.appendFile(target, `${ls.join('\n')}\n`, 'utf8');
          moved += ls.length;
          void h;
        } catch (err) {
          this.log.warn?.(`[归档] 迁移 ${day} ${h} 时失败：${err.message}`);
        }
      }
      try {
        await fsp.rename(full, `${full}.migrated`);
        doneFiles.push({ file: f, lines: lines.length });
      } catch (err) {
        this.log.warn?.(`[归档] 迁移后改名失败（老档先留着）：${err.message}`);
      }
    }
    if (moved) this.log.info?.(`[归档] 布局迁移：${doneFiles.length} 个老档、${moved} 行 → 新结构（老档改名 .migrated）`);
    return { moved, files: doneFiles };
  }
}
