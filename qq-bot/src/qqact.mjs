/**
 * 「她自己的账号，她自己管」—— QQ 侧的**对外动作**层（2026-10-08 用户定的规则）。
 *
 * 总原则（写进代码，免得以后被顺手放宽）：
 *   **对外新增/改变 → 要先审；收回/撤销 → 免审。**
 *
 * | 动作 | 审不审 | OneBot 接口 |
 * | --- | --- | --- |
 * | 发说说 | **要审**（先存草稿 → 主人点头 → 才发） | `send_qzone_msg` |
 * | 删说说 | 免审（她不想留就自己删） | `delete_qzone_msg` |
 * | 改昵称 / 签名 | **要审** | `set_qq_profile` |
 * | 改头像 | **要审** | `set_qq_avatar` |
 * | **改回上一版（回滚）** | 免审 —— 审计日志同时就是**撤销栈** | 同上 |
 * | 在线状态 / 自定义状态 | 免审（自动） | `set_online_status` / `set_diy_online_status` |
 * | 性别 / 年龄 / 生日 | **接口里没有这些字段，改不了** | — |
 * | 改密码 / 换绑 / 加删好友 / 看别人资料 | **不做**（不可逆 + 碰凭据 + 影响账号安全） | — |
 *
 * 三条不变量（和 `control.mjs` 同一套纪律）：
 *   1. **闸在执行层**：每个动作执行前重判「私聊 + 主人 + 总开关」，`ctx` 由 bot.mjs 现算，模型碰不到；
 *   2. **群里连工具定义都看不到**（`toolsForContext` 只在私聊主人时注入）；
 *   3. **每件事都写审计**（`logs/qq-act.log`）——它同时是**撤销栈**与**频率计数**的唯一来源。
 *
 * ⚠️ 这里**不碰任何机器的东西**（那是 `control.mjs` 的活），只管 QQ 账号本身。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROOT } from './config.mjs';

const DEFAULT_LOG = 'logs/qq-act.log';

/**
 * 审计日志的路径。**可以配**（`qqAct.logFile`）—— 自测必须能把它指到临时目录，
 * 否则一跑就写进用户那份真日志（`reminders.file` / `memory.file` 当年都踩过这个坑）。
 */
export function qqactLogFile(cfg) {
  return resolve(ROOT, String(cfg?.qqAct?.logFile ?? DEFAULT_LOG));
}

/** 草稿有效期：过了就当废纸（免得三天后一句「发」把旧草稿发出去）。 */
/**
 * 草稿多久作废。
 *
 * ⚠️ **2026-10-22 从 30 分钟收到 10 分钟**（用户报「嗯被映射走了」✓）：
 *    那次「发说说」草稿挂到第 30 分钟边缘时，用户随口一句「嗯」被确认词吃掉 ✗。
 *    草稿是"**刚要发的这一句**"，超过 10 分钟还没点头，多半是早就聊别的去了 ✓ ——
 *    让它自动作废，比留着等一个误会强 ✓。
 */
const DRAFT_TTL_MS = 10 * 60 * 1000;

/* ─────────────────────────── 准入 ─────────────────────────── */

export function qqactEnabled(cfg) {
  return cfg?.qqAct?.enabled !== false;
}

/** 唯一的准入判断。**fail-closed**：ctx 缺字段 / 不是私聊 / 不是主人 —— 一律拒。 */
/** get_qq_profile 这个实现支持不？实测 NapCat 不支持（1404）——别每次白试。
 */
let getProfileUnsupported = false;

export function qqactAllowed(cfg, ctx) {
  if (!qqactEnabled(cfg)) return false;
  if (!ctx || typeof ctx !== 'object') return false;
  if (ctx.isPrivate !== true) return false;
  if (ctx.isMaster !== true) return false;
  return true;
}

/* ─────────────────────── 审计日志（= 撤销栈） ─────────────────────── */

/**
 * 追加一条审计。**只追加，不改写**（它同时是撤销栈，改历史等于把撤销能力弄坏）。
 * @param {{action:string, ok?:boolean, [k:string]:any}} entry
 */
export function appendAct(entry, file = resolve(ROOT, DEFAULT_LOG)) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, 'utf8');
    return true;
  } catch {
    return false; // 审计写不进去也不该把动作带崩（但下面会把这件事说出来）
  }
}

/** 读回全部审计（坏行跳过 —— 半行 JSON 不该让整个撤销栈失效）。 */
export function readActs(file = resolve(ROOT, DEFAULT_LOG)) {
  try {
    if (!existsSync(file)) return [];
    const out = [];
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t);
        if (j && typeof j === 'object') out.push(j);
      } catch {
        /* 坏行跳过 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 是不是"今天"（本地时区！UTC 会把凌晨那几条算到前一天去）。 */
export function sameLocalDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
  );
}

/** 今天已经成功做了几次 `action`（频率上限用它算，**不另存状态**）。 */
export function actsToday(acts, action, now = Date.now()) {
  return (acts ?? []).filter((a) => a?.action === action && a?.ok !== false && sameLocalDay(a.at ?? 0, now)).length;
}

/**
 * 上一次**成功的资料改动**（撤销栈的栈顶）。
 * 只有带 `before` 的条目才是可回滚的 —— 没记 before 就没法回滚，宁可不给。
 */
export function pickRollback(acts, actions = ['profile', 'avatar']) {
  const list = (acts ?? []).filter((a) => actions.includes(a?.action) && a?.ok !== false && a?.before);
  return list.length ? list[list.length - 1] : null;
}

/**
 * 频率上限查询：`{ ok, used, cap, why }`。
 * `section` 是配置里放上限的那一节（QQ 侧 `qqAct`、B站 侧 `biliAct`）——
 * 两边的上限都从**同一个日志计数思路**算，所以机制共用，只是读不同配置节。
 */
export function checkQuota(cfg, acts, action, now = Date.now(), section = 'qqAct') {
  const cap = Number(cfg?.[section]?.[`max${action[0].toUpperCase()}${action.slice(1)}PerDay`] ?? 0);
  const used = actsToday(acts, action, now);
  if (!cap) return { ok: true, used, cap: 0, why: '' }; // 没配上限 = 不限
  if (used >= cap) return { ok: false, used, cap, why: `今天已经 ${used} 次了（上限 ${cap}）` };
  return { ok: true, used, cap, why: '' };
}

/**
 * 「这三件事**由她自己决定什么时候动**」——签名 / 昵称 / QQ空间说说。
 *
 * 用户 2026-10-09 的原话：「签名和昵称和动态（qq空间）是他自己决定什么时候发，我只审批。」
 * 所以规矩从"**等他开口**"改成"**她主动提**"，但**执行那一脚仍然要他点头**：
 *
 *   她自己拟一版 → 念给主人听 → 主人说「可以/行/就这个/改/发」→ 程序真的执行。
 *
 * 为什么这句提示非有不可：实测模型**不会主动调工具**，也不会觉得自己"有资格决定"——
 * 不给它这句话，它永远只会等着被吩咐（或者更糟：被吩咐了还嘴上说做了）。
 *
 * @returns {string} 拼进系统提示词的一段；关掉时给空串
 */
export function selfInitiatedHint(cfg) {
  const q = cfg?.qqAct ?? {};
  if (q.enabled === false || q.selfInitiated === false) return '';
  const post = Number(q.maxPostPerDay ?? 3);
  const prof = Number(q.maxProfilePerDay ?? 1);
  return (
    '【账号上的三件事：时机由你自己定，但要他点头】\n' +
    '你的**个性签名、QQ昵称、QQ空间说说**，什么时候改、什么时候发，**由你自己决定**——不用等他开口。\n' +
    '想动的时候就：**先自己拟好一版 → 把内容念给他听 → 问他行不行**（比如「我想把签名换成这个，行不行」）。\n' +
    '他点头（「可以」「行」「就这个」「改」「发」）之后，程序会**真的执行**；\n' +
    `**他点头之前你一个字都不能动，更不能说「已经改了」「已经发了」**。到上限（说说每天 ${post} 条、资料每天 ${prof} 次）就说明天再说，别硬磨。`
  );
}

/* ─────────────────────────── 待审草稿 ─────────────────────────── */

/**
 * 待审草稿：**一次只存一件、只认一个会话、用过即废、超时作废**。
 * 只放内存 —— 它是"我正要问他的那句话"，重启后本来就该重新问。
 */
const drafts = new Map(); // key(=会话) -> { kind, args, at, text }

export function setDraft(key, kind, args, text, now = Date.now()) {
  drafts.set(String(key), { kind, args, at: now, text });
}

export function getDraft(key, now = Date.now()) {
  const d = drafts.get(String(key));
  if (!d) return null;
  if (now - d.at > DRAFT_TTL_MS) {
    drafts.delete(String(key));
    return null;
  }
  return d;
}

export function clearDraft(key) {
  return drafts.delete(String(key));
}

/** 给"代码接管确认"那一步用：有没有还没作废的草稿、是哪一种。 */
export function draftKind(key, now = Date.now()) {
  return getDraft(key, now)?.kind ?? '';
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

/** 把口语状态词换成 OneBot 的状态码（认不出就返回 null，让调用方明确说不知道）。 */
export function statusToCode(word) {
  const s = String(word ?? '').trim();
  if (/在线|在线状态/.test(s)) return 10;
  if (/离开|走开|暂离/.test(s)) return 30;
  if (/隐身|勿扰|别打扰/.test(s)) return 40;
  if (/忙碌|忙/.test(s)) return 50;
  if (/听歌|音乐/.test(s)) return 60;
  if (/游戏/.test(s)) return 70;
  return null;
}

/** 日志里给内容留个可核对的摘要（正文本身不进日志的 `before/after`，太长）。 */
function clip(text, n = 120) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…（共 ${t.length} 字）` : t;
}

/* ─────────────────────────── 工具声明 ─────────────────────────── */

export const QQACT_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'qzone_post',
      description:
        '在**她自己的 QQ 空间**发一条说说（草稿）。⚠️ **不会立刻发出去**：先把草稿存下，' +
        '你要把草稿原文念给主人看、问他要不要发；他说了「发」之后你再调 qzone_confirm。',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string', description: '说说正文（一到三句，用自己的口吻）' } },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qzone_delete',
      description:
        '删一条说说（**不需要审批**：撤回是对外"收回"而不是"新增"）。不传 msg_id 就删**最近发的那条**。',
      parameters: {
        type: 'object',
        properties: { msg_id: { type: 'string', description: '要删的说说 id；不传 = 最近一条' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qq_profile_set',
      description:
        '改**她自己的**昵称 / 个性签名（草稿，**要主人点头**）。只传要改的那个字段。改完可以用 qq_profile_rollback 退回上一版。',
      parameters: {
        type: 'object',
        properties: {
          nickname: { type: 'string', description: '新昵称（不传就不改）' },
          personal_note: { type: 'string', description: '新个性签名（不传就不改）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qq_avatar_set',
      description: '换**她自己的**头像（草稿，**要主人点头**）。传一张图片的 URL。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '图片地址（http/https）' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qq_profile_rollback',
      description:
        '把昵称/签名/头像**退回上一版**（**不需要审批** —— 撤销不算"对外新增"）。上一版从审计日志里取。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qq_online_status',
      description: '给她设在线状态（免审）。status 用口语词：在线 / 离开 / 隐身 / 忙碌；可选 text 设自定义状态文字。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: '在线 / 离开 / 隐身 / 忙碌' },
          text: { type: 'string', description: '自定义状态文字（可选）' },
        },
        required: ['status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qq_confirm',
      description: '主人点头之后，把**待审的那件事**真的做掉（发说说 / 改资料 / 换头像）。只在他明确同意后用。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const QQACT_TOOL_NAMES = new Set(QQACT_TOOL_DEFS.map((d) => d.function.name));

/* ─────────────────────────── 执行 ─────────────────────────── */

/**
 * 执行一次「账号自理」工具。**永远返回字符串**（给模型看），永远不抛。
 *
 * @param cfg 配置（热重载的同一个对象）
 * @param name 工具名
 * @param args 模型给的参数
 * @param ctx  { isPrivate, isMaster, who, onebot } —— `onebot` 由 bot.mjs 注入（自测里换成替身）
 */
export async function runQqActTool(cfg, name, args = {}, ctx = null) {
  // ⚠️ `LOG` 必须在**最前面**定：被拒的那条也要进审计（"谁想干什么被拦了"同样是证据），
  // 而拒绝分支在准入判断里就返回了 —— 定义放后面会变成 TDZ ReferenceError。
  const LOG = qqactLogFile(cfg); // 审计/撤销栈/计数都从这一份里读写（自测可指到临时目录）
  if (!QQACT_TOOL_NAMES.has(name)) return `错误：没有叫 ${name} 的账号工具。`;
  if (!qqactAllowed(cfg, ctx)) {
    // fail-closed：非主人私聊。**仍然记一条**（含是谁想干什么），但不含敏感内容
    appendAct({ action: name, ok: false, note: '拒绝：非主人私聊', args: args ?? {} }, LOG);
    return '这个只能在主人的私聊里用（她自己的账号，也只在他面前动）。';
  }
  const a = args ?? {};
  /**
   * ⚠️ **必须 bind，不能把方法摘下来用**（10-08 埋的雷，10-09 用户报「我让他改他没改」才炸出来）：
   * `OneBot.call()` 是**原型方法**，内部读 `this.ws`。写成 `const call = ctx.onebot.call` 再调用，
   * `this` 就没了 → 抛 `Cannot read properties of undefined (reading 'ws')` →
   * **所有 QQ 账号动作（说说/签名/在线状态/删说说）执行即崩**。
   * 更阴的是：**自测里替身的 `call` 是箭头函数（没有 `this`），所以全绿** —— 这就是它躲过测试的原因。
   * 现在的自测里放了一个"用 `this` 的替身"，专门盯这条。
   */
  const bot = ctx?.onebot ?? null;
  const call = typeof bot?.call === 'function' ? bot.call.bind(bot) : null;
  if (!call) return '拿不到 OneBot 连接，这次做不了（机器人可能刚重启，等一下再试）。';
  const who = String(ctx?.who ?? '');
  const acts = readActs(LOG);

  const run = async (action, params, extra = {}) => {
    try {
      const r = await call(action, params);
      return { ok: true, r };
    } catch (err) {
      appendAct({ action: name, api: action, ok: false, why: err.message, args: a }, LOG);
      return { ok: false, err };
    }
  };

  switch (name) {
    /* ---- 要审的三件：都只**存草稿**，不动账号 ---- */
    case 'qzone_post': {
      const content = String(a.content ?? '').trim();
      if (!content) return '说说正文是空的 —— 你得先写点什么。';
      if (content.length > 500) return `太长了（${content.length} 字），说说别超过 500 字。`;
      setDraft(who, 'qzone', { content }, content);
      appendAct({ action: 'draft', kind: 'qzone', ok: true, args: { content: clip(content) } }, LOG);
      return (
        `草稿存下了（${content.length} 字）。**现在把它原文念给主人看，问他要不要发** —— ` +
        '他同意之后再调 `qq_confirm`。他不点头我一个字都不会发出去。'
      );
    }

    case 'qq_profile_set': {
      const nickname = String(a.nickname ?? '').trim();
      const note = String(a.personal_note ?? '').trim();
      if (!nickname && !note) return '昵称和签名都没给 —— 至少说一个要改成什么。';
      if (nickname && (nickname.length > 24 || /\s/.test(nickname))) return '昵称不太对：QQ 昵称一般不超过 24 字，也不带空格。';
      if (note && note.length > 60) return `签名太长了（${note.length} 字），一般不超过 60 字。`;
      setDraft(who, 'profile', { nickname, personal_note: note }, `${nickname || '（不改昵称）'} / ${note || '（不换签名）'}`);
      appendAct({ action: 'draft', kind: 'profile', ok: true, args: { nickname, personal_note: clip(note) } }, LOG);
      return '草稿存下了。把要改成什么念给主人听，他点头后再调 `qq_confirm`（不点头我不动资料）。';
    }

    case 'qq_avatar_set': {
      const url = String(a.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) return '头像要一个 http/https 的图片地址。';
      setDraft(who, 'avatar', { url }, url);
      appendAct({ action: 'draft', kind: 'avatar', ok: true, args: { url } }, LOG);
      return '头像草稿存下了。先跟主人说一声换哪张，他点头后再调 `qq_confirm`。';
    }

    /* ---- 点头之后真的执行 ---- */
    case 'qq_confirm': {
      /**
       * ⚠️ **"点头"只能来自主人那句话**（2026-10-09 补的真漏洞）：原来这里只看"槽里有没有草稿"，
       * 于是模型可以在一轮里 `qzone_post`（存草稿）+ `qq_confirm`（自己确认）→ **自己批准自己**，
       * 用户定的"我只审批"就白设了。`ctx.userApproved` 只由**用户那句话**（批准词）置位。
       */
      if (ctx?.userApproved !== true) {
        appendAct({ action: name, ok: false, note: '拒绝：没有主人的点头（模型不能自己批准自己）', args: a }, LOG);
        return '这一步要**主人点头**才能做 —— 我这边只认他说的「可以 / 行 / 就这个 / 改 / 发」，我自己说"确认"不算。把内容念给他听，等他的回复。';
      }
      const d = getDraft(who);
      if (!d) return '现在没有待办的事（草稿要么没存过、要么已经过了有效期）。';
      if (d.kind === 'qzone') {
        const q = checkQuota(cfg, acts, 'post');
        if (!q.ok) {
          clearDraft(who);
          return `今天发得够多了 —— ${q.why}。这条草稿作废了，明天再说。`;
        }
        const res = await run('send_qzone_msg', { content: d.args.content });
        if (!res.ok) return `发失败了：${res.err.message}`;
        clearDraft(who);
        const id = res.r?.message_id ?? res.r?.data?.message_id ?? res.r?.msg_id ?? null;
        appendAct({ action: 'post', ok: true, msgId: id, preview: clip(d.args.content) }, LOG);
        return `发出去了${id ? `（id ${id}）` : ''}。`;
      }
      if (d.kind === 'profile') {
        const q = checkQuota(cfg, acts, 'profile');
        if (!q.ok) {
          clearDraft(who);
          return `今天改得够多了 —— ${q.why}。草稿作废，明天再说。`;
        }
        /**
         * ⚠️ **不要二次解包**（2026-10-09 实测栽在这上面，用户报「两个东西一个都没改好」）：
         * `onebot.call()` 内部已经解出了 `msg.data`（见 `onebot.mjs` 的 `#onMessage`），
         * 所以真机返回的是**扁平**形状 `{user_id, nickname, …}`；我再取 `.data` 就永远是 undefined
         * → 拿不到当前昵称 → 下面那道"必填"守卫直接把动作拦下。
         * 而自测里的替身是**嵌套**的 `{data:{nickname}}`，于是测试替我圆过去了 —— 又一次"替身形状不等于真身"。
         * 现在**两种形状都认**，并且拿不到就退一步问标准接口 `get_login_info`。
         */
        // ⚠️ **实测（2026-10-09，直连 NapCat 探针）：这个实现里根本没有 `get_qq_profile`** ——
        //    回的是 `retcode=1404 不支持的API get_qq_profile`。所以昵称只能靠**标准接口 `get_login_info`**：
        //    它返回扁平形状 `{user_id, nickname:"喵小笛喵～"}`（实测）。
        //    （10-08 交接笔记里写"`get_qq_profile` 可用"是错的说法，已改。）
        //    不支持过的接口记下来，别每次白试一遍。
        // `before` 存**改之前的值** → 这就是撤销栈能工作的原因
        let before = null;
        if (!getProfileUnsupported) {
          const rawProf = await call('get_qq_profile', {}).catch((err) => {
            if (/不支持的API|unsupported/i.test(String(err?.message ?? ''))) getProfileUnsupported = true;
            return null;
          });
          before = rawProf?.data ?? rawProf ?? null;
        }
        const params = {};
        // ⚠️ **`nickname` 是必填的**（NapCat 的 `set_qq_profile` 要求）——只改签名时也必须带上当前昵称，
        //    否则这个接口会直接拒（2026-10-08 交接笔记里记着这条，我第一版漏了）。
        if (d.args.nickname) params.nickname = d.args.nickname;
        else if (before?.nickname) params.nickname = before.nickname;
        let curNick = params.nickname ?? '';
        if (!curNick) {
          // 退路：标准 OneBot 接口，几乎各实现都有（真机实测可用）
          const login = await call('get_login_info', {}).catch(() => null);
          curNick = login?.nickname ?? login?.data?.nickname ?? '';
          if (curNick) params.nickname = curNick;
        }
        if (d.args.personal_note) params.personal_note = d.args.personal_note;
        if (!params.nickname) {
          // 到这一步是真拿不到：**明确说清楚**，别让用户以为改过了
          appendAct({ action: 'profile', ok: false, note: '拿不到当前昵称，未执行', args: d.args }, LOG);
          return '拿不到当前昵称（`get_qq_profile` / `get_login_info` 都没给），而这个接口要求昵称必填 —— 这次没改，别以为改过了。';
        }
        /**
         * **把 `before` 补成真能用的**（2026-10-09 修）：真机上 `get_qq_profile` 不存在 → 原来 `before` 恒为
         * `null` → 账本里 `before:null` → `pickRollback()` 挑不到它 → **「改回去」对资料压根失效**。
         * 现在：昵称用**改之前真实读到的**那个；签名读不回来（没有接口），退而用**本机记录里最后一次值**，
         * 并标明来源 —— 宁可能用但标注，也不要一个用不了的 `null`。
         */
        const lastKnown = [...acts].reverse().find((x) => x.action === 'profile' && x.ok !== false && x.after?.personal_note);
        /**
         * ⚠️ **合并，不是覆盖**（2026-10-09 自己踩的）：我第一版把 `before` 整个换成合成值，
         * 结果把它**真正读到的**旧值（比如 `get_qq_profile` 那边给回来的签名）丢掉了 →
         * 回滚只能写回昵称、签名变 `null` → 两条老断言当场红了。
         * 正确形状：**真读到的优先，缺的才用"本机记录的上一次值"补**，并标明哪些是补的。
         */
        before = {
          nickname: before?.nickname || curNick,
          personal_note: before?.personal_note ?? lastKnown?.after?.personal_note ?? null,
          ...(before?.nickname || before?.personal_note ? {} : { note: '昵称=改之前读到的；签名=本机记录的上一次值（接口读不回来）' }),
        };
        const res = await run('set_qq_profile', params);
        if (!res.ok) return `改失败了：${res.err.message}`;
        clearDraft(who);
        /**
         * ⚠️⚠️ **别拿 `get_login_info` 当"改没改成功"的裁判**（2026-10-09 我在这上面栽了一次）：
         * 我改完昵称，12 秒里读了 6 次 `get_login_info`，**六次全是旧值**
         * → 我据此下结论"**昵称根本改不动**"，还把它写进代码（直接拒绝执行）。
         * **结果用户那边昵称确实变成了「小笛」** —— `get_login_info` 返回的是**缓存值**，根本没刷新。
         *
         * 所以原则改成：**接口回成功就算写上去了**（我们没有可信的回读手段）；
         * 读到旧值只能当"可能还没生效"的提示，**绝不当失败判决** —— 让主人自己看一眼资料。
         * 与 B站 那条"回读要留重试窗口"配成一对：**回读不仅要留窗口，还要先确认这个回读源可信**。
         */
        let verify = '';
        if (params.nickname) {
          const seen = (await call('get_login_info', {}).catch(() => null))?.nickname ?? '';
          if (seen && seen !== params.nickname) {
            verify =
              `\n（我这边回读到的还是「${seen}」，但**这个接口给的是缓存值、不可信** —— 今天就是它骗了我一次，` +
              '让我误判"昵称改不动"。改是改下去了：**跟主人说让他自己在资料页看一眼确认**，别替他打包票。）';
          } else if (seen === params.nickname) {
            verify = `\n（回读确认：昵称已经是「${seen}」）`;
          }
        }
        if (params.personal_note) {
          verify += '\n（签名**没法回读验证** —— NapCat 没有"读资料"的接口；让主人自己看一眼签名栏。）';
        }
        appendAct({ action: 'profile', ok: true, args: params, before, after: params }, LOG);
        return `改好了：${JSON.stringify(params)}。不满意随时说"改回去"。${verify}`;
      }
      if (d.kind === 'avatar') {
        const q = checkQuota(cfg, acts, 'avatar');
        if (!q.ok) {
          clearDraft(who);
          return `今天换得够多了 —— ${q.why}。草稿作废。`;
        }
        const res = await run('set_qq_avatar', { file: d.args.url });
        if (!res.ok) return `换头像失败了：${res.err.message}`;
        clearDraft(who);
        appendAct({ action: 'avatar', ok: true, args: { url: d.args.url } }, LOG);
        return '头像换好了。';
      }
      // ⚠️ **不是自己的草稿就别动它**：B站 那侧的待审（kind='follow'）归 `bili_confirm` 管。
      //    这里如果顺手 clearDraft，就会把另一边的草稿悄悄吃掉（自测当场抓到了这个）。
      return '这不是 QQ 这边的待办（B站 那边的事请用 bili_confirm）。草稿我没动。';
    }

    /* ---- 免审的：撤回 / 回滚 / 在线状态 ---- */
    case 'qzone_delete': {
      let id = String(a.msg_id ?? '').trim();
      if (!id) {
        const last = acts.filter((x) => x?.action === 'post' && x?.ok !== false && x?.msgId).pop();
        id = String(last?.msgId ?? '');
        if (!id) return '我不知道要删哪条（日志里没有记下 id）—— 把说说的 id 给我。';
      }
      const q = checkQuota(cfg, acts, 'delete');
      if (!q.ok) return `删得够多了 —— ${q.why}。`;
      const res = await run('delete_qzone_msg', { msg_id: id });
      if (!res.ok) return `删失败了：${res.err.message}`;
      appendAct({ action: 'delete', ok: true, msgId: id }, LOG);
      return `删了（id ${id}）。`;
    }

    case 'qq_profile_rollback': {
      const last = pickRollback(acts);
      if (!last) return '日志里没有可回滚的上一版（我只记得改过什么才能退回去）。';
      const b = last.before ?? {};
      const params = {};
      if (b.nickname) params.nickname = String(b.nickname);
      // ⚠️ `null` 也要当"没有"（2026-10-09 踩过：`null !== undefined && null !== ''` 都为真，
      //    于是把 `personal_note: null` 原样发了出去）
      const note = typeof b.personal_note === 'string' ? b.personal_note.trim() : '';
      if (note) params.personal_note = note;
      if (!params.nickname) {
        // 昵称是必填的：只回滚签名时也得先把当前昵称取回来
        const login = await call('get_login_info', {}).catch(() => null);
        const nick = login?.nickname ?? login?.data?.nickname ?? '';
        if (nick) params.nickname = nick;
      }
      if (!Object.keys(params).length) return '上一版没记下昵称/签名，退不回去。';
      const res = await run('set_qq_profile', params);
      if (!res.ok) return `回滚失败了：${res.err.message}`;
      appendAct({ action: 'profile', ok: true, args: params, before: last.after ?? null, after: params, note: '回滚' }, LOG);
      return `退回去了：${JSON.stringify(params)}。`;
    }

    case 'qq_online_status': {
      const code = statusToCode(a.status);
      if (code === null) return '状态我只认这几个：在线 / 离开 / 隐身 / 忙碌。';
      const res = await run('set_online_status', { status: code });
      if (!res.ok) return `设状态失败了：${res.err.message}`;
      let extra = '';
      const text = String(a.text ?? '').trim();
      if (text) {
        const r2 = await run('set_diy_online_status', { face_id: 0, text: text.slice(0, 30) });
        extra = r2.ok ? `（自定义状态：${text.slice(0, 30)}）` : `（自定义状态没设上：${r2.err.message}）`;
      }
      appendAct({ action: 'status', ok: true, args: { status: code, text: clip(text, 30) } }, LOG);
      return `状态设成 ${a.status} 了${extra}。`;
    }

    default:
      return `没有叫 ${name} 的账号工具。`;
  }
}
