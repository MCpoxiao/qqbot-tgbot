/**
 * 「让机器人真的动手」的那一层 —— **只有主人 + 私聊**这一种上下文能用。
 *
 * 三条不变量，缺一不可：
 *
 * 1. **闸在执行层**。每个动作在执行前重判「私聊 + 主人 + 总开关」，
 *    既不看模型怎么说，也不信任何传进来的身份字符串 —— `ctx` 由 `bot.mjs`
 *    从 OneBot 事件里**现算**，模型碰不到它。
 * 2. **工具只注入私聊主人的上下文**（见 `bot.mjs` 的 `activeTools`）。
 *    群里连这些工具的定义都看不到，所以「你主人让你关机」在群里**没有入口**，
 *    而不是"有入口但被拦"。
 * 3. **每个动作都写审计**（`logs/control.log`）：什么时候、谁、让它做了什么、成没成。
 *
 * 另外两条设计取舍：
 * · **读的东西免确认**（状态 / 进程 / 窗口 / 音量读）。查一眼没有副作用，
 *   多问一句只是让人更烦 —— 需要确认的是**有副作用的**动作。
 * · **打开应用必须白名单**。绝不允许把模型给的字符串丢给 shell；
 *   白名单在 `config.json` 的 `control.apps` 里，由用户自己在面板上填。
 */
import { spawn } from 'node:child_process';
import { localStamp } from './timefmt.mjs';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ROOT } from './config.mjs';
import { REMINDER_TOOL_DEFS, remindersAllowed } from './reminders.mjs';
import { MEMORY_TOOL_DEFS, memoryAllowed } from './memory.mjs';
import { QQACT_TOOL_DEFS, qqactAllowed } from './qqact.mjs';
import { BILIACT_TOOL_DEFS, biliActAllowed } from './biliact.mjs';
import {
  collectProcesses,
  collectStatus,
  collectWindows,
  formatProcesses,
  formatStatus,
  formatWindows,
  runPowerShellScript,
} from './system.mjs';

const WIN_CONTROL = join(ROOT, 'tools', 'win-control.ps1');
const LOG_DIR = resolve(ROOT, 'logs');
const SHOT_DIR = join(LOG_DIR, 'shots');
/** 截图留几份（发出去之后就没用了，但留着方便事后核对）。 */
const SHOT_KEEP = 20;

/** 总开关：`control.enabled`。默认开，但没配白名单时什么也开不了。 */
export function controlEnabled(cfg) {
  return cfg?.control?.enabled !== false;
}

/**
 * 唯一的准入判断。**fail-closed**：ctx 缺字段、不是私聊、不是主人 —— 一律拒。
 */
export function controlAllowed(cfg, ctx) {
  if (!controlEnabled(cfg)) return false;
  if (!ctx || typeof ctx !== 'object') return false;
  return ctx.isPrivate === true && ctx.isMaster === true;
}

/** 审计。写不进去也不该把动作本身带崩，所以吞异常（但会打一行 warn）。 */
function audit(ctx, name, args, outcome) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const who = ctx?.who ?? '?';
    appendFileSync(join(LOG_DIR, 'control.log'), `${localStamp()} | ${who} | ${name} | ${JSON.stringify(args ?? {})} | ${outcome}\n`);
  } catch {
    /* 审计尽力而为 */
  }
}

/** 按名字找白名单里的应用（大小写不敏感；也允许用可执行文件名匹配）。 */
export function findApp(cfg, name) {
  const apps = Array.isArray(cfg?.control?.apps) ? cfg.control.apps : [];
  const want = String(name ?? '').trim().toLowerCase();
  if (!want) return null;
  for (const a of apps) {
    if (!a || typeof a.path !== 'string' || !a.path.trim()) continue;
    const appName = String(a.name ?? '').trim().toLowerCase();
    const exe = basename(a.path).replace(/\.exe$/i, '').toLowerCase();
    if (want === appName || want === exe) return { name: a.name ?? basename(a.path), path: a.path };
  }
  return null;
}

/**
 * 口语名 → 窗口标题/进程名里可能出现的各种写法。
 * 目的：让用户**说个大概也能截到**（"把浏览器截图"、"b站那个"），而不是必须报全名。
 */
const WINDOW_ALIASES = {
  浏览器: ['chrome', 'msedge', 'firefox', 'brave', 'edge'],
  b站: ['哔哩哔哩', 'bilibili'],
  哔哩: ['哔哩哔哩', 'bilibili'],
  视频: ['哔哩哔哩', 'bilibili', 'potplayer', 'vlc'],
  歌词: ['桌面歌词'],
  资源管理器: ['explorer', '文件资源管理器'],
  文件夹: ['explorer', '文件资源管理器'],
  设置: ['systemsettings', 'applicationframehost'],
  记事本: ['notepad'],
  终端: ['windowsterminal', 'pwsh', 'powershell', 'cmd'],
  命令行: ['pwsh', 'powershell', 'cmd'],
  代码: ['code', 'vscode'],
  音乐: ['QQMusic', 'QQ音乐'],
  qq音乐: ['QQMusic', 'QQ音乐'],
  微信: ['wechat'],
  steam: ['steam'],
  dsh: ['DeepSeek Harness'],
  助手: ['DeepSeek Harness'],
};

/** 粗归一化：小写 + 去掉空白和常见包裹符号。 */
function normKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s\-_()（）[\]【】·.。]/g, '');
}

/**
 * 把一个「大概是窗口名」的词扩成一组可尝试的关键字（原词永远保留）。
 * 纯函数，可测。
 */
export function expandWindowMatch(phrase) {
  const raw = String(phrase ?? '').trim();
  if (!raw) return [];
  const out = new Set([raw]);
  const key = normKey(raw);
  if (key.length >= 2) {
    for (const [k, list] of Object.entries(WINDOW_ALIASES)) {
      if (key === k || key.includes(k) || k.includes(key)) {
        for (const v of list) out.add(v);
      }
    }
  }
  return [...out].filter(Boolean);
}

/**
 * 「要截哪个窗口」的解析：**指代词**（那个/刚才/再截一次/空）就取上一次记住的目标。
 * 抽成纯函数是为了能测 —— 这条决定了"不用每次报全名"能不能成立。
 */
export function resolveWindowTarget(asked, refs) {
  const s = String(asked ?? '').trim();
  const remembered = refs?.window?.match || refs?.window?.title || '';
  const isRef = !s || /^(那个|这个|它|刚才|刚刚|上次|上一个|同一个|再|还是)/.test(s);
  if (isRef) return { target: remembered, isRef: true };
  return { target: s, isRef: false };
}

/** 截图黑名单（进程名，小写）。默认挡掉最不该外传的几类。 */
export function screenshotBlocklist(cfg) {
  const list = cfg?.control?.screenshot?.blocklist;
  return Array.isArray(list) ? list.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
}

/** 留最近 SHOT_KEEP 张截图，其余删掉（别把盘塞满）。 */
function pruneShots() {
  try {
    const files = readdirSync(SHOT_DIR)
      .filter((f) => f.endsWith('.png'))
      .map((f) => ({ f, t: statSync(join(SHOT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(SHOT_KEEP)) rmSync(join(SHOT_DIR, f), { force: true });
  } catch {
    /* 目录还不存在之类，忽略 */
  }
}

/**
 * 抓一个指定窗口（**不是全屏**）。返回结果对象，不抛。
 * 先 PrintWindow，黑图/失败再退回「顶到前台 + 抓屏裁剪」——后者是可见副作用，
 * 所以结果里会带上 method，好让回复里说清楚。
 */
export async function captureWindow(cfg, { match, timeoutMs = 20000 } = {}) {
  const keyword = String(match ?? '').trim();
  if (!keyword) return { ok: false, error: '没给窗口关键词' };
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
  } catch { /* 下面写文件时会明确报错 */ }
  const out = join(SHOT_DIR, `shot-${Date.now()}.png`);
  const res = await runPowerShellScript(
    WIN_CONTROL,
    [
      '-Action',
      'screenshot',
      '-Match',
      expandWindowMatch(keyword).join(','), // 口语名在 JS 这边扩成别名串（可测），PS 只负责逐个试
      '-Out',
      out,
      '-Blocklist',
      screenshotBlocklist(cfg).join(','),
    ],
    { timeoutMs },
  );
  if (!res.ok) {
    const candidates = res.data?.candidates;
    return { ok: false, error: res.error, candidates: Array.isArray(candidates) ? candidates : [] };
  }
  pruneShots();
  return { ok: true, ...res.data };
}

/** 音量读/写。level 是 0..1；mute 是 true/false/undefined。 */
export async function controlVolume({ level, mute, timeoutMs = 10000 } = {}) {
  const wantLevel = Number.isFinite(level);
  const wantMute = mute === true || mute === false;
  if (!wantLevel && !wantMute) {
    return runPowerShellScript(WIN_CONTROL, ['-Action', 'volume-get'], { timeoutMs });
  }
  const args = ['-Action', 'volume-set'];
  if (wantLevel) args.push('-Level', String(Math.max(0, Math.min(1, level))));
  if (wantMute) args.push('-Mute', mute ? 'true' : 'false');
  return runPowerShellScript(WIN_CONTROL, args, { timeoutMs });
}

/**
 * 媒体键：play_pause / next / prev / stop。控的是**正在放的那个**。
 *
 * ⚠️ 超时给到 25 秒：这个动作**按完要量两段电平**（前 2.5s + 后 5s，见 win-control.ps1），
 * 加上 Add-Type 编译和按完的等待，总共约 12–14 秒。10 秒的默认超时会让它"按了却报超时"
 * ——2026-10-07 真踩过：音乐其实停了，回执却是「脚本 10 秒没返回」，用户看到的是失败。
 */
export async function controlMedia(action, { timeoutMs = 25000 } = {}) {
  const allowed = ['play_pause', 'next', 'prev', 'stop'];
  if (!allowed.includes(action)) return { ok: false, error: `不认识的媒体动作：${action}` };
  return runPowerShellScript(WIN_CONTROL, ['-Action', 'media', '-MediaAction', action], { timeoutMs });
}

/** 读一次「现在有没有声音」（2 秒采样取最大，避免被歌的安静段骗）。 */
export async function audioPeak({ timeoutMs = 15000 } = {}) {
  const res = await runPowerShellScript(WIN_CONTROL, ['-Action', 'audio-peak'], { timeoutMs });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, peak: Number(res.data.peak), playing: res.data.playing === true };
}

/** 打开白名单里的应用。**不做 shell**，只 spawn 绝对路径。 */
export function openApp(cfg, name) {
  const app = findApp(cfg, name);
  if (!app) {
    const names = (Array.isArray(cfg?.control?.apps) ? cfg.control.apps : []).map((a) => a?.name).filter(Boolean);
    return {
      ok: false,
      error: names.length
        ? `「${name}」不在白名单里。现在能开的是：${names.join('、')}`
        : '白名单还是空的 —— 要开应用得先在控制面板的「控制」里填进去（名字 = exe 绝对路径）。',
    };
  }
  if (!existsSync(app.path)) return { ok: false, error: `白名单里那条路径不存在了：${app.path}` };
  try {
    const child = spawn(app.path, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, name: app.name, path: app.path };
  } catch (err) {
    return { ok: false, error: `启动失败：${err.message}` };
  }
}

/* ─────────────────────────── 给模型的工具定义 ─────────────────────────── */

export const CONTROL_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'computer_status',
      description:
        '看这台电脑现在的状态：整体负载（CPU/内存/磁盘/开机时长）、占资源最多的进程、当前开了哪些窗口。用户问「电脑卡不卡」「我在玩什么」「开了什么程序」时用它。只读，不改任何东西。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['status', 'processes', 'windows'],
            description: 'status=整体状态；processes=进程榜；windows=窗口列表。默认 status',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot_window',
      description:
        '给**某一个窗口**截图并发给主人（不是全屏截图）。用户说「截个图」「把那个 XX 窗口发我」时用它。match 用窗口标题或程序名的一部分即可，**不用报全名**：「浏览器」「b站」「设置」「歌词」这种口语说法都可以；也可以给「刚才那个」这种指代（会复用上一次成功的目标）。抓不到会告诉你可以选哪些窗口。',
      parameters: {
        type: 'object',
        properties: {
          match: { type: 'string', description: '窗口标题或程序名的一部分（中文英文都行）' },
        },
        required: ['match'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'volume',
      description:
        '调节这台电脑的音量或静音。用户说「声音小一点」「静音」「音量调到 30」时用它。不传任何参数就是**读**当前音量。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'integer', description: '目标音量，0-100；不传表示不动音量', minimum: 0, maximum: 100 },
          delta: { type: 'integer', description: '相对当前音量增减多少（例如想「小一点」就给 -10）；与 level 二选一' },
          mute: { type: 'boolean', description: 'true=静音，false=取消静音；不传表示不动静音状态' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'media_control',
      description:
        '控制**正在播放**的音乐/视频：播放暂停、下一首、上一首、停止。用户说「暂停一下」「切歌」「继续放」时用它。注意它控制的是当前那个播放器，不是指定某一个。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['play_pause', 'next', 'prev', 'stop'], description: '要做的动作' },
          want: {
            type: 'string',
            enum: ['play', 'pause'],
            description:
              '只有 play_pause 用得上：明确要「放」还是要「停」。给了就会先量一次有没有声音 —— 本来就停着/本来就在放时**什么都不做**（开关按下去会反向）',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description:
        '打开**白名单里**的某个应用。用户说「帮我开一下微信/QQ音乐/记事本」时用它。白名单由主人在控制面板里维护 —— 不在名单里的应用**必须明说开不了**，不要试图绕。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '应用名，例如「微信」「QQ音乐」' },
        },
        required: ['name'],
      },
    },
  },
];

export const CONTROL_TOOL_NAMES = new Set(CONTROL_TOOL_DEFS.map((d) => d.function.name));

/**
 * 按上下文决定**注入哪些工具**。抽成纯函数是为了能测 ——
 * 「群里到底看不看得到这些工具」是这套设计的命门，不能只靠运行时观察。
 *
 * 这里同时管三类"主人私聊专用"工具：**操控这台电脑**（`control.mjs`）、
 * **定时提醒**（`reminders.mjs`）、**她自己的 QQ 账号**（`qqact.mjs`）。
 * 它们共用同一个注入点，但各有各的开关。
 */
export function toolsForContext(baseDefs, cfg, ctx) {
  const extra = [];
  if (controlAllowed(cfg, ctx)) extra.push(...CONTROL_TOOL_DEFS);
  if (remindersAllowed(cfg, ctx)) extra.push(...REMINDER_TOOL_DEFS);
  if (memoryAllowed(cfg, ctx)) extra.push(...MEMORY_TOOL_DEFS);
  if (qqactAllowed(cfg, ctx)) extra.push(...QQACT_TOOL_DEFS);
  if (biliActAllowed(cfg, ctx)) extra.push(...BILIACT_TOOL_DEFS);
  return [...baseDefs, ...extra];
}

/* ─────────────────────────── 执行 ─────────────────────────── */

/**
 * 执行一次控制类工具。**永远返回字符串**（给模型看），永远不抛。
 *
 * @param cfg 当前配置（热重载的同一个对象）
 * @param name 工具名
 * @param args 模型给的参数
 * @param ctx  { isPrivate, isMaster, who, sendImage? } —— 由 bot.mjs 从事件里现算
 */
export async function runControlTool(cfg, name, args = {}, ctx = null) {
  if (!CONTROL_TOOL_NAMES.has(name)) return `错误：没有叫 ${name} 的控制工具。`;
  if (!controlAllowed(cfg, ctx)) {
    audit(ctx, name, args, '拒绝：非主人私聊');
    return '这个只能在主人的私聊里用（群里我不会碰这台电脑）。';
  }

  const a = args ?? {};
  try {
    switch (name) {
      case 'computer_status': {
        const kind = ['status', 'processes', 'windows'].includes(a.kind) ? a.kind : 'status';
        const text =
          kind === 'processes'
            ? formatProcesses(await collectProcesses())
            : kind === 'windows'
              ? formatWindows(await collectWindows())
              : formatStatus(await collectStatus());
        audit(ctx, name, { kind }, 'ok');
        return text;
      }

      case 'screenshot_window': {
        // 「不用每次报全名」靠这两步：指代词 → 上一次记住的目标；口语名 → 别名串
        const { target, isRef } = resolveWindowTarget(a.match, ctx?.refs);
        if (!target) {
          audit(ctx, name, a, '拒绝：不知道截哪个');
          return '你要截的是哪个窗口？说个大概就行（「浏览器」「b站」「设置」「歌词」这种），上一轮我没记下目标。';
        }
        const res = await captureWindow(cfg, { match: target });
        if (!res.ok) {
          audit(ctx, name, a, `失败：${res.error}`);
          const hint = res.candidates?.length
            ? `\n现在能截的窗口有：${res.candidates.slice(0, 8).join('、')}`
            : '';
          return `没截到：${res.error}${hint}`;
        }
        // 记下这次的目标 —— 下次「再截一次」「还是那个」就能接上
        if (ctx?.refs) ctx.refs.window = { match: target, title: res.title };
        // 图**直接发出去**，而不是把路径塞给模型（模型发不出本地文件）
        let sent = false;
        if (typeof ctx?.sendImage === 'function') {
          sent = await ctx.sendImage(res.file, { title: res.title }).catch(() => false);
        }
        audit(ctx, name, a, `ok ${res.title} ${res.width}x${res.height} ${res.method}`);
        const how =
          res.method === 'screen-crop'
            ? '（这个窗口不给直接抓图，我把它顶到前面用抓屏裁的）'
            : '';
        return sent
          ? `已经截好发出去了：窗口「${res.title}」${res.width}x${res.height}${how}`
          : `截到了但没发出去（图片上传失败）：${res.file}`;
      }

      case 'volume': {
        const mute = a.mute === true ? true : a.mute === false ? false : undefined;
        let level = Number.isFinite(a.level) ? Math.max(0, Math.min(100, Number(a.level))) / 100 : undefined;
        /**
         * `delta`：**不让模型先去读一遍再算**（它算错、或者根本忘了读）。
         * 代码自己读当前值、自己夹到 0–100、自己写。模型只要说"低一点"。
         */
        if (level === undefined && Number.isFinite(Number(a.delta)) && Number(a.delta) !== 0) {
          const cur = await controlVolume({});
          const curPct = Number(cur?.data?.volume);
          if (Number.isFinite(curPct)) {
            level = Math.max(0, Math.min(100, curPct + Number(a.delta))) / 100;
          }
        }
        const res = await controlVolume({ level, mute });
        if (!res.ok) {
          audit(ctx, name, a, `失败：${res.error}`);
          return `音量没调成：${res.error}`;
        }
        const d = res.data ?? {};
        audit(ctx, name, a, `ok ${JSON.stringify(d)}`);
        if (level === undefined && mute === undefined) {
          return `当前音量 ${d.volume}%${d.muted ? '，而且是静音状态' : ''}。`;
        }
        const bits = [];
        if (level !== undefined) bits.push(`音量从 ${d.before}% 调到 ${d.after}%`);
        if (mute !== undefined) bits.push(d.muted ? '已静音' : '已取消静音');
        return `${bits.join('，')}。`;
      }

      case 'media_control': {
        const action = String(a.action ?? '');
        const want = a.want === 'play' ? 'play' : a.want === 'pause' ? 'pause' : undefined;
        /**
         * `play_pause` 是**开关**：「帮我放一下」如果它本来就在放，按下去就变成暂停了。
         * 所以给得出方向时（want）先量一次电平：
         * 要停而本来就没声，或要放而本来就在放 —— **什么都不做**，如实说一句。
         */
        if (action === 'play_pause' && want) {
          const now = await audioPeak();
          if (now.ok) {
            if (want === 'pause' && !now.playing) {
              audit(ctx, name, a, `ok 本来就没在放（电平 ${now.peak}）`);
              return `本来就停着呢（电平 ${now.peak}），我没动它。`;
            }
            if (want === 'play' && now.playing) {
              audit(ctx, name, a, `ok 本来就在放（电平 ${now.peak}）`);
              return `本来就在放（电平 ${now.peak}），我没动它。`;
            }
          }
        }
        const res = await controlMedia(action);
        if (!res.ok) {
          audit(ctx, name, a, `失败：${res.error}`);
          return `媒体控制没成：${res.error}`;
        }
        const d = res.data ?? {};
        const words = { play_pause: '播放/暂停', next: '下一首', prev: '上一首', stop: '停止' };
        const label = words[action] ?? action;
        const before = Number(d.peakBefore);
        const after = Number(d.peakAfter);
        const q = (v) => (Number.isFinite(v) && v >= 0 ? v.toFixed(2) : '?');
        const quiet = (v) => !(v >= 0.02);
        audit(ctx, name, a, `ok 电平 ${d.peakBefore}->${d.peakAfter}`);
        /**
         * **如实说**。媒体键是"盲按"：`SendInput`/`keybd_event` 返回成功只代表**键送出去了**，
         * 不代表播放器认它。2026-10-07 实测：键发出去了、`GetLastError=0`，而音乐照放。
         *
         * 所以按前后各量一段**声音电平**，但**只认两种压倒性的证据**：
         * 「有声 → 几乎无声」= 停了；「几乎无声 → 有声」= 放起来了。
         * 别拿"电平变了一点"当成功 —— 歌本身就在起伏（实测 0.63→0.45 明明还在放）。
         */
        if (!Number.isFinite(before) || !Number.isFinite(after)) {
          return `已按「${label}」键（这次量不出电平，没法确认生效没有）。`;
        }
        if (action === 'play_pause' || action === 'stop') {
          if (!quiet(before) && quiet(after)) return `按了「${label}」，电平从 ${q(before)} 掉到 ${q(after)} —— **停了**。`;
          if (quiet(before) && !quiet(after)) return `按了「${label}」，电平从 ${q(before)} 起来了 —— **放起来了**。`;
          if (!quiet(before) && !quiet(after)) {
            return `我按了「${label}」键，但电平前后差不多（${q(before)} → ${q(after)}）—— **它没停**，多半不响应这个媒体键。`;
          }
          return `已按「${label}」键，但前后都没声音（${q(before)} → ${q(after)}），没法判断。`;
        }
        return `已按「${label}」键（电平 ${q(before)} → ${q(after)}）。切歌这类动作，我没法从电平判断成功没有。`;
      }

      case 'open_app': {
        const res = openApp(cfg, a.name);
        if (!res.ok) {
          audit(ctx, name, a, `拒绝/失败：${res.error}`);
          return res.error;
        }
        audit(ctx, name, a, `ok ${res.path}`);
        return `开了「${res.name}」。`;
      }

      default:
        return `错误：控制工具 ${name} 还没实现。`;
    }
  } catch (err) {
    audit(ctx, name, a, `异常：${err.message}`);
    return `执行 ${name} 出错：${err.message}`;
  }
}
