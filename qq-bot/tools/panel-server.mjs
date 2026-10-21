/**
 * 本地控制面板。
 *
 * 动机：改一个词都要改文件 + 重启，太别扭。这个面板让你在浏览器里
 * 直接调人格、切模型、设密钥、编白名单、管表情包。
 *
 * 两个安全边界，是刻意设计而不是省事：
 *   1. **只监听 127.0.0.1**，不接受外部连接。
 *   2. **API 密钥只进不出**：可以写、可以看到"配没配"，任何接口都不会把它读回来。
 *      面板页面上也不会显示已保存的密钥。
 *
 * 它只负责改 config.json；机器人自己 watch 这个文件，改完即时生效，不用重启。
 *
 * 用法：node tools/panel-server.mjs   然后打开 http://127.0.0.1:6182/
 */
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { basename, extname, join, resolve } from 'node:path';
import { ROOT } from '../src/config.mjs';
import { readBiliJct, readCookieValue, readSessData } from '../src/bilibili.mjs';
import { TAGS_MANUAL_FILE, readManualTagMap, readTagMap } from '../src/stickers.mjs';
import { cleanTag } from './tag-stickers.mjs';
import { pickImages, readZip } from '../src/zip.mjs';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PANEL_PORT ?? 6182);
const CONFIG_FILE = resolve(ROOT, 'config.json');
const EXAMPLE_FILE = resolve(ROOT, 'config.example.json');
const KEY_FILE = resolve(ROOT, '.deepseek-key');
/** B站登录凭证（SESSDATA）。**和机器人读的是同一个文件**，写这里就等于写好。 */
const BILI_COOKIE_FILE = resolve(ROOT, 'bili-cookie.txt');
// pixiv 的登录 cookie（R-18 的查看/下载要它）——2026-10-10 用户要求放进面板、跟 B站 一起。
const PIXIV_COOKIE_FILE = resolve(ROOT, 'pixiv-cookie.txt');
const STATUS_FILE = resolve(ROOT, 'logs/bot-status.json');
const STICKER_DIR = resolve(ROOT, 'stickers');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/* ------------------------------ 小工具 ------------------------------ */

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 先写临时文件再改名，避免机器人读到写了一半的配置。 */
function writeAtomic(file, text) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, file);
  } catch {
    // Windows 上目标被占用时 rename 会失败，退回直接写
    writeFileSync(file, text, 'utf8');
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

function portOpen(port, timeout = 500) {
  return new Promise((res) => {
    const sock = connect({ port, host: HOST });
    const done = (ok) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function keyState() {
  const envName = 'DEEPSEEK_API_KEY';
  if (process.env[envName]?.trim()) return { configured: true, source: `环境变量 $${envName}` };
  try {
    if (readFileSync(KEY_FILE, 'utf8').trim()) return { configured: true, source: '文件 .deepseek-key' };
  } catch {
    /* 没配 */
  }
  return { configured: false, source: null };
}

/**
 * B站登录状态。**只报「配没配、从哪读的、多长」，绝不回显内容**（和密钥同一条纪律）。
 *
 * 2026-10-08 拆成**两个口**：`SESSDATA`（登录态，看字幕/详情用）与 `bili_jct`（csrf，点赞/投币/收藏用）。
 * 解析**复用机器人那份逻辑**（`readCookieValue`）—— 面板和机器人对同一个文件必须**读出同样的东西**，
 * 各写一份迟早会有一个不认 `KEY=VALUE`（那天就是"取第一条非注释行"把整行当值）。
 */
/** pixiv 登录态：只报「配没配 + 长度」，**值永不回显**（跟 biliState 一个规矩）。 */
function pixivState() {
  let body = '';
  try {
    body = readFileSync(PIXIV_COOKIE_FILE, 'utf8');
  } catch {
    body = '';
  }
  const one = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join(' ');
  return {
    configured: !!one,
    length: one.length,
    source: one ? 'pixiv-cookie.txt' : null,
  };
}

function biliState() {
  const envOf = (env) => {
    const v = process.env[env]?.trim();
    return v ? { configured: true, source: `环境变量 $${env}`, length: v.length } : null;
  };
  const sess = envOf('BILI_SESSDATA') ?? { configured: false, source: null, length: readSessData().length };
  const jct = envOf('BILI_JCT') ?? { configured: false, source: null, length: readBiliJct().length };
  if (!sess.configured && sess.length) sess.configured = true;
  if (!jct.configured && jct.length) jct.configured = true;
  // 文件来源单独标一下（两个口都在同一个文件里）
  if (!sess.source && sess.configured) sess.source = '文件 bili-cookie.txt';
  if (!jct.source && jct.configured) jct.source = '文件 bili-cookie.txt';

  return {
    // 兼容老字段（概览行/状态文案在用）：configured/length 指 SESSDATA
    configured: sess.configured,
    source: sess.source,
    length: sess.length,
    sessdata: sess,
    jct,
  };
}

function listStickers() {
  try {
    // 标签优先取 tags.manual.json（你手改的），其次 tags.json（视觉识别），最后退回文件名
    const visionMap = readTagMap(STICKER_DIR);
    const manualMap = readManualTagMap(STICKER_DIR);
    return readdirSync(STICKER_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.') && IMAGE_EXT.has(extname(e.name).toLowerCase()))
      .map((e) => {
        const ext = extname(e.name).toLowerCase();
        const manual = manualMap[e.name];
        const byManual = typeof manual === 'string' && manual.trim().length > 0;
        const vision = visionMap[e.name];
        const byVision = !byManual && typeof vision === 'string' && vision.trim().length > 0;
        const tag = byManual
          ? manual.trim()
          : byVision
            ? vision.trim()
            : e.name.slice(0, -ext.length).replace(/[-_ ]\d+$/, '');
        return { file: e.name, tag, byVision, byManual, size: statSync(join(STICKER_DIR, e.name)).size };
      })
      .sort((a, b) => a.tag.localeCompare(b.tag, 'zh'));
  } catch {
    return [];
  }
}

/* ------------------------------ 配置读写 ------------------------------ */

/**
 * 人格上限。**这不是"随便定个 4000"**：
 * 人格是每一轮请求都带的固定前缀，越长越贵（有前缀缓存时会便宜些，但仍然占上下文）。
 * 20000 字 ≈ 两万 token 量级，对现在的上下文窗口还算安全，也是"够用且不至于失控"的量级。
 * ⚠️ 但**超了要明确报错，不许悄悄切** —— 2026-10-07 真踩过：旧代码 `str(v, 4000)` 把主人
 * 加了半天的人格**静默截在第 4000 个字**，config.json 里那句 "- 禁" 就是被切出来的半句话，
 * 而面板还回了一句"已保存"。用户看到的现象是"我加不进去东西"。
 */
const PERSONA_MAX = 20000;

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max).trim() : undefined);
const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : undefined);
const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 200) : undefined);
const oneOf = (v, allowed) => (allowed.includes(v) ? v : undefined);

/**
 * 把面板传来的 patch 叠到现有 config.json 上。
 * 只认白名单字段——面板不可能往配置里塞进乱七八糟的东西。
 */
function applyPatch(existing, patch) {
  const next = { ...existing };

  // 人格：**超长就拒，不截断**（截断会让用户以为保存成功了）
  const rawPersona = typeof patch.persona === 'string' ? patch.persona.trim() : undefined;
  if (rawPersona !== undefined && rawPersona.length > PERSONA_MAX) {
    return { __error: `人格太长了：${rawPersona.length} 字，上限 ${PERSONA_MAX} 字。**没有保存**（免得被截掉一截你还以为成了）—— 缩一缩再来。` };
  }
  if (rawPersona !== undefined && rawPersona.length > 0) {
    next.llm = { ...(next.llm ?? {}), system: rawPersona };
  }

  const provider = oneOf(patch.provider, ['deepseek', 'ollama', 'echo']);
  if (provider) next.llm = { ...(next.llm ?? {}), provider };

  const model = str(patch.model, 120);
  if (model && provider !== 'echo') {
    const key = provider === 'ollama' ? 'ollama' : 'deepseek';
    next.llm = { ...(next.llm ?? {}), [key]: { ...(next.llm?.[key] ?? {}), model } };
  }

  const temperature = num(patch.temperature, 0, 2);
  if (temperature !== undefined) {
    const key = (provider ?? next.llm?.provider) === 'ollama' ? 'ollama' : 'deepseek';
    next.llm = { ...(next.llm ?? {}), [key]: { ...(next.llm?.[key] ?? {}), temperature } };
  }

  const maxTokens = num(patch.maxTokens, 64, 4096);
  if (maxTokens !== undefined) {
    next.llm = { ...(next.llm ?? {}), deepseek: { ...(next.llm?.deepseek ?? {}), maxTokens } };
  }

  const tp = oneOf(patch.triggerPrivate, ['all', 'off']);
  const tg = oneOf(patch.triggerGroup, ['mention', 'all', 'keyword', 'off']);
  if (tp || tg) {
    next.trigger = { ...(next.trigger ?? {}) };
    if (tp) next.trigger.private = tp;
    if (tg) next.trigger.group = tg;
  }

  const users = list(patch.whitelistUsers);
  const groups = list(patch.whitelistGroups);
  if (users || groups) {
    next.whitelist = { ...(next.whitelist ?? {}) };
    if (users) next.whitelist.users = users;
    if (groups) next.whitelist.groups = groups;
  }

  const cooldown = num(patch.cooldownMs, 0, 60000);
  const turns = num(patch.historyTurns, 0, 50);
  const maxReply = num(patch.maxReplyChars, 50, 4000);
  if (cooldown !== undefined || turns !== undefined || maxReply !== undefined) {
    next.limits = { ...(next.limits ?? {}) };
    if (cooldown !== undefined) next.limits.cooldownMs = cooldown;
    if (turns !== undefined) next.limits.historyTurns = turns;
    if (maxReply !== undefined) next.limits.maxReplyChars = maxReply;
  }

  /**
   * ⚠️ **2026-10-15 新增：运行方式相关的键**（用户要求「把新配置也放进面板」）。
   *
   * 以前这些只能手改 config.json；现在面板也能改。三点注意：
   *   1. **`transport` 改了必须重启机器人** ✗（传输层是启动时建的，不是热重载）——
   *      所以前端那句提示必须写清楚，否则用户会以为改了没生效；
   *   2. 语音那三项都落在 `telegram.*` 里，而且**只动这三个字段**——
   *      用展开保留同级的 `tokenFile` / `masterUserId`（别把它们冲掉）；
   *   3. `voiceRate` 允许**负数**（SAPI 语速是 -10..10），所以是 `num(v, -10, 10)`。
   */
  const transport = oneOf(patch.transport, ['onebot', 'telegram']);
  if (transport) next.transport = transport;
  const voiceName = str(patch.voiceName, 80);
  const voiceRate = num(patch.voiceRate, -10, 10);
  const pollSeconds = num(patch.pollSeconds, 5, 50);
  if (voiceName || voiceRate !== undefined || pollSeconds !== undefined) {
    next.telegram = { ...(next.telegram ?? {}) }; // 保留 tokenFile / masterUserId
    if (voiceName) next.telegram.voiceName = voiceName;
    if (voiceRate !== undefined) next.telegram.voiceRate = voiceRate;
    if (pollSeconds !== undefined) next.telegram.pollSeconds = pollSeconds;
  }
  // 「他引用时我也引用回他」——只认真正的布尔（别把字符串 "false" 当成 true）
  if (typeof patch.quoteBack === 'boolean') {
    next.chat = { ...(next.chat ?? {}), quoteBack: patch.quoteBack };
  }

  // 「主人」这个称呼只给名单里的 QQ 号
  const masters = list(patch.masterUsers);
  if (masters) next.master = { ...(next.master ?? {}), users: masters };

  // 恋人关系（**只对主人**，对别人一个字都不变）
  if (typeof patch.romantic === 'boolean') {
    next.master = { ...(next.master ?? {}), romantic: patch.romantic };
  }

  // 工具
  if (patch.tools !== undefined && typeof patch.tools === 'object' && patch.tools !== null) {
    const t = patch.tools;
    next.tools = { ...(next.tools ?? {}) };
    if (typeof t.enabled === 'boolean') next.tools.enabled = t.enabled;
    const rounds = num(t.maxRounds, 1, 8);
    if (rounds !== undefined) next.tools.maxRounds = rounds;
  }

  // 说话节奏（拆成几条消息发）
  if (patch.chat !== undefined && typeof patch.chat === 'object' && patch.chat !== null) {
    const c = patch.chat;
    next.chat = { ...(next.chat ?? {}) };
    if (typeof c.bubbles === 'boolean') next.chat.bubbles = c.bubbles;
    const mb = num(c.maxBubbles, 1, 8);
    if (mb !== undefined) next.chat.maxBubbles = Math.round(mb);
    const dm = num(c.delayMs, 0, 8000);
    if (dm !== undefined) next.chat.delayMs = Math.round(dm);
    const pc = num(c.delayPerChar, 0, 300);
    if (pc !== undefined) next.chat.delayPerChar = Math.round(pc);
    const dx = num(c.delayMax, 0, 15000);
    if (dx !== undefined) next.chat.delayMax = Math.round(dx);
  }

  // 语音
  if (patch.voice !== undefined && typeof patch.voice === 'object' && patch.voice !== null) {
    const v = patch.voice;
    next.voice = { ...(next.voice ?? {}) };
    if (typeof v.enabled === 'boolean') next.voice.enabled = v.enabled;
    if (typeof v.character === 'string' && v.character.trim()) next.voice.character = v.character.trim().slice(0, 60);
    const gap = num(v.minIntervalMs, 0, 3600000);
    if (gap !== undefined) next.voice.minIntervalMs = Math.round(gap);
  }

  // 放歌
  if (patch.music !== undefined && typeof patch.music === 'object' && patch.music !== null) {
    const m = patch.music;
    next.music = { ...(next.music ?? {}) };
    if (typeof m.enabled === 'boolean') next.music.enabled = m.enabled;
    const mx = num(m.maxPerReply, 0, 5);
    if (mx !== undefined) next.music.maxPerReply = Math.round(mx);
  }

  // 嘴硬频率（由代码控制，模型只负责执行）
  const brat = num(patch.bratEveryN, 0, 20);
  if (brat !== undefined) next.tone = { ...(next.tone ?? {}), bratEveryN: Math.round(brat) };
  if (patch.vibe !== undefined) {
    const vibe = oneOf(patch.vibe, ['genki', '']) ?? '';
    next.tone = { ...(next.tone ?? {}), vibe };
  }

  // 主动开口
  if (patch.proactive !== undefined && typeof patch.proactive === 'object' && patch.proactive !== null) {
    const p = patch.proactive;
    next.proactive = { ...(next.proactive ?? {}) };
    if (typeof p.enabled === 'boolean') next.proactive.enabled = p.enabled;
    if (typeof p.groups === 'boolean') next.proactive.groups = p.groups;
    const after = num(p.afterMinutes, 5, 10080);
    const gap = num(p.minGapMinutes, 5, 10080);
    const maxDay = num(p.maxPerDay, 1, 20);
    if (after !== undefined) next.proactive.afterMinutes = after;
    if (gap !== undefined) next.proactive.minGapMinutes = gap;
    if (maxDay !== undefined) next.proactive.maxPerDay = maxDay;
    const qf = num(p.quietFrom, 0, 23);
    const qt = num(p.quietTo, 0, 23);
    if (qf !== undefined || qt !== undefined) {
      next.proactive.quietHours = { ...(next.proactive.quietHours ?? {}) };
      if (qf !== undefined) next.proactive.quietHours.from = qf;
      if (qt !== undefined) next.proactive.quietHours.to = qt;
    }
  }

  return next;
}

/* ------------------------------ HTTP ------------------------------ */

const MAX_BODY = 64 * 1024 * 1024; // 单张图最大 8MB；zip 走 base64 会膨胀 4/3，所以整体放宽到 64MB
const MAX_ZIP = 40 * 1024 * 1024; // 解压前的 zip 本身上限

function readBody(req) {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        rej(new Error('请求体过大（表情包最大 8MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return res({});
      try {
        res(JSON.parse(text));
      } catch (e) {
        rej(new Error(`请求体不是合法 JSON：${e.message}`));
      }
    });
    req.on('error', rej);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    /* ---------- 页面 ---------- */
    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }

    /* ---------- 一次性拉全量状态 ---------- */
    if (req.method === 'GET' && p === '/api/state') {
      const [onebotUp, napcatUp] = await Promise.all([portOpen(3001), portOpen(6099)]);
      return json(res, 200, {
        config: readJson(CONFIG_FILE, {}),
        example: readJson(EXAMPLE_FILE, {}),
        status: readJson(STATUS_FILE, null),
        stickers: listStickers(),
        key: keyState(),
        bili: biliState(),
        pixiv: pixivState(),
        ports: { onebot: onebotUp, napcat: napcatUp },
        configFile: CONFIG_FILE,
      });
    }

    /* ---------- 它最近动过什么（控制审计日志的尾部） ---------- */
    if (req.method === 'GET' && p === '/api/controllog') {
      let lines = [];
      try {
        lines = readFileSync(join(ROOT, 'logs', 'control.log'), 'utf8').split('\n').filter(Boolean).slice(-20);
      } catch {
        /* 还没动过任何东西 */
      }
      return json(res, 200, { ok: true, lines });
    }

    /* ---------- 保存配置 ---------- */
    if (req.method === 'POST' && p === '/api/config') {
      const patch = await readBody(req);
      const existing = readJson(CONFIG_FILE, {});
      const next = applyPatch(existing, patch);
      // 校验失败时**什么都不写**，并把原因原样回给面板（例如人格超长）
      if (next && next.__error) return json(res, 400, { ok: false, error: next.__error });
      writeAtomic(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
      return json(res, 200, { ok: true, config: next });
    }

    /* ---------- 写入密钥（只进不出） ---------- */
    if (req.method === 'POST' && p === '/api/key') {
      const body = await readBody(req);
      const key = str(body.key, 300);
      if (!key) return json(res, 400, { ok: false, error: '密钥是空的' });
      if (!/^[\x21-\x7e]+$/.test(key)) return json(res, 400, { ok: false, error: '密钥只能包含可见 ASCII 字符，别带空格或换行' });
      writeAtomic(KEY_FILE, key + '\n');
      const st = keyState();
      return json(res, 200, {
        ok: true,
        note:
          st.source?.includes('环境变量')
            ? '已写入文件，但**环境变量优先**，当前实际生效的是环境变量里的那个'
            : '已写入 .deepseek-key，机器人每次请求都会重读，不用重启',
        key: { configured: true, source: st.source },
      });
    }

    /* ---------- 写入 B站 凭证（同样只进不出） ---------- */
    /**
     * 两个口：`sessdata`（登录态）与 `biliJct`（csrf）。
     * 规矩（2026-10-08 用户要求）：
     *   · **分开填、分开存**（文件里是 `SESSDATA=…` / `bili_jct=…` 两行）；
     *   · **留空 = 不改那一项**（用户只想更新一个值时不至于把另一个抹掉）；
     *   · 两个都空 → 报错；
     *   · 校验沿用原有那套（可见 ASCII、长度下限；bili_jct 一般是 32 位十六进制）。
     */
    if (req.method === 'POST' && p === '/api/bili-cookie') {
      const body = await readBody(req);
      /**
       * ⚠️⚠️ **2026-10-15 修的真 bug（用户报「pixiv cookie 填不了」）**：
       *
       * `str()` 对**非字符串返回 `undefined`** ✗，而这里紧接着 `.trim()` ✗
       * ⇒ 只要**有一个框没填**（"只填 pixiv 的 PHPSESSID"就是最正常的用法 ✓）
       * 就抛 `Cannot read properties of undefined (reading 'trim')` ⇒ **接口 500** ✗✗
       * （实测复现：POST 只带 `pixivPhpSess` → HTTP 500 ✓，前端看起来就是"填了没反应" ✓）。
       *
       * 这个雷是 **2026-10-10** 加 pixiv 那三行时埋下的 ✓，而且它同时**打坏了 B站 保存** ✓
       * （那两个框也没填时同样 500 ✓）。修法：**每个框都先兜成空串** ✓（留空 = 不改那一项，语义不变 ✓）。
       */
      const sess = (str(body.sessdata, 400) ?? '').trim();
      const jct = (str(body.biliJct, 200) ?? '').trim();
      // ⚠️ 2026-10-10：这个端点现在还管 pixiv，所以「三个框全空」才算空
      //（原来只看 B站 两项，会把"只填 pixiv"的请求挡掉 —— 那会让新功能直接不可用）。
      const pxRaw = (str(body.pixivPhpSess, 400) ?? '').trim();
      if (!sess && !jct && !pxRaw) return json(res, 400, { ok: false, error: '三个框都空着 —— 至少填一个（留空的那项会保持原样）' });

      if (sess) {
        if (!/^[\x21-\x7e]+$/.test(sess)) {
          return json(res, 400, { ok: false, error: '看着不像 SESSDATA：只能包含可见 ASCII，别带空格或换行' });
        }
        if (sess.length < 40) {
          return json(res, 400, {
            ok: false,
            error: `SESSDATA 太短了（只有 ${sess.length} 个字符）—— 一般一两百字符，你是不是只复制了一段？`,
          });
        }
      }
      if (jct && !/^[0-9a-f]{32}$/i.test(jct)) {
        return json(res, 400, {
          ok: false,
          error: `看着不像 bili_jct：它是 **32 位十六进制**（你这串 ${jct.length} 个字符）。` + '别把 SESSDATA 粘到这个框里。',
        });
      }

      // 留空的那项沿用文件里的现值（值本身不回显给前端）
      const next = {
        sessdata: sess || readCookieValue('SESSDATA'),
        jct: jct || readCookieValue('bili_jct'),
      };

      // **保留文件里原有的注释行** —— 手动打开看还有说明
      let keptComments = [];
      try {
        keptComments = readFileSync(BILI_COOKIE_FILE, 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.trim().startsWith('#'));
      } catch {
        /* 文件不存在就只写值 */
      }
      const lines = [...keptComments];
      if (next.sessdata) lines.push(`SESSDATA=${next.sessdata}`);
      if (next.jct) lines.push(`bili_jct=${next.jct}`);
      writeAtomic(BILI_COOKIE_FILE, lines.join('\n') + '\n');

      /* ---------- pixiv（R-18 的查看/下载要登录）---------- */
      const px = pxRaw;
      const pxDev = (str(body.pixivDevice, 400) ?? '').trim();
      if (px && !/^[\x21-\x7e]+$/.test(px)) {
        return json(res, 400, { ok: false, error: 'pixiv 的 PHPSESSID 只能包含可见 ASCII，别带空格或换行' });
      }
      if (px && px.length < 20) {
        return json(res, 400, {
          ok: false,
          error:
            "PHPSESSID 太短了（只有 " +
            px.length +
            " 个字符）—— 一般 20 个以上。别把 B站 的 SESSDATA 填到这里（两个站的 cookie 名不一样）。",
        });
      }
      let pixivWrote = '';
      if (px) {
        let pxComments = [];
        try {
          pxComments = readFileSync(PIXIV_COOKIE_FILE, 'utf8')
            .split(/\r?\n/)
            .filter((l) => l.trim().startsWith('#'));
        } catch {
          /* 文件不存在就只写值 */
        }
        // ⚠️ 必须写成**一行**（pixiv.mjs 的 pixivCookie() 把非注释行用空格拼起来，
        //    拆两行会变成 "PHPSESSID=x device_token=y" —— 少了分号，认证会失败）
        const one = "PHPSESSID=" + px + (pxDev ? "; device_token=" + pxDev : "");
        writeAtomic(PIXIV_COOKIE_FILE, [...pxComments, one].join("\n") + "\n");
        pixivWrote = "PHPSESSID" + (pxDev ? " + device_token" : "");
      }


      const wrote = [sess ? 'SESSDATA' : '', jct ? 'bili_jct' : ''].filter(Boolean).join(' + ');
      return json(res, 200, {
        ok: true,
        note: `已写入 ${wrote}（${
          sess && jct ? '两项都更新了' : '留空的那项保持原样'
        }）。机器人**每次用之前都重读**这个文件，不用重启。`,
        bili: biliState(),
        pixiv: pixivState(),
        pixivNote: pixivWrote
          ? "pixiv：已写入 " + pixivWrote + "（机器人每次用之前重读，不用重启）。"
          : "pixiv 那栏留空 → 保持原样。",
      });
    }

    /* ---------- 上传表情包 ---------- */
    if (req.method === 'POST' && p === '/api/sticker') {
      const body = await readBody(req);
      const rawName = str(body.name, 80);
      const dataUrl = str(body.data, MAX_BODY);
      if (!rawName || !dataUrl) return json(res, 400, { ok: false, error: '缺少文件名或文件内容' });

      // 文件名只留最后一个路径段，再去掉危险字符——绝不能让它写到 stickers/ 之外
      const ext = extname(rawName).toLowerCase();
      if (!IMAGE_EXT.has(ext)) return json(res, 400, { ok: false, error: `不支持的图片格式：${ext || '（无扩展名）'}` });
      const stem = basename(rawName, ext).replace(/[[\]/\r\n\\:*?"<>|]/g, '').trim().slice(0, 40);
      if (!stem) return json(res, 400, { ok: false, error: '文件名去掉扩展名后是空的' });

      const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(dataUrl);
      if (!m) return json(res, 400, { ok: false, error: '只能上传 base64 编码的图片' });

      const buf = Buffer.from(m[1], 'base64');
      if (buf.length === 0) return json(res, 400, { ok: false, error: '图片内容为空' });
      if (buf.length > 8 * 1024 * 1024) return json(res, 400, { ok: false, error: '图片超过 8MB' });

      mkdirSync(STICKER_DIR, { recursive: true });
      const target = join(STICKER_DIR, `${stem}${ext}`);
      writeFileSync(target, buf);
      return json(res, 200, { ok: true, saved: basename(target), note: `标签是「${stem}」，机器人重启一次就会知道这个新标签` });
    }

    /* ---------- 梗库：读 / 写 ---------- */
    if (p === '/api/memes') {
      const memeFile = join(ROOT, 'memes.md');
      if (req.method === 'GET') {
        let text = '';
        try {
          text = readFileSync(memeFile, 'utf8');
        } catch {
          text = '';
        }
        return json(res, 200, { ok: true, text });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '');
        // 上限是防手滑：梗库会整份接进 prompt，太大就不划算了
        if (text.length > 20000) {
          return json(res, 400, { ok: false, error: `梗库太长了（${text.length} 字，上限 20000）` });
        }
        writeAtomic(memeFile, text);
        return json(res, 200, { ok: true, note: '已保存，下一条消息就生效（不用重启）' });
      }
    }

    /* ---------- 手动改一个标签 ---------- */
    if (req.method === 'POST' && p === '/api/sticker/tag-edit') {
      const body = await readBody(req);
      const file = basename(str(body.file, 160) ?? '');
      const rawTag = str(body.tag, 60) ?? '';
      if (!file || !IMAGE_EXT.has(extname(file).toLowerCase())) {
        return json(res, 400, { ok: false, error: '文件名不合法' });
      }
      if (!existsSync(join(STICKER_DIR, file))) {
        return json(res, 404, { ok: false, error: '这个文件已经不在了' });
      }

      const manualFile = join(STICKER_DIR, TAGS_MANUAL_FILE);
      const manual = readManualTagMap(STICKER_DIR);

      // 清空 = 撤销手改，退回自动识别（没有就退回文件名）
      if (!rawTag.trim()) {
        delete manual[file];
        if (Object.keys(manual).length) writeAtomic(manualFile, JSON.stringify(manual, null, 2) + '\n');
        else rmSync(manualFile, { force: true });
        return json(res, 200, { ok: true, tag: null, note: '已撤销手改，退回自动识别的标签' });
      }

      const tag = cleanTag(rawTag);
      if (!tag) {
        return json(res, 400, { ok: false, error: '标签不合法：1–6 个字，不能含斜杠或换行' });
      }

      manual[file] = tag;
      writeAtomic(manualFile, JSON.stringify(manual, null, 2) + '\n');
      // 标点/引号是被**剥掉**而不是报错的，那就如实说，别让用户以为自己打的就是这个
      const changed = tag !== rawTag.trim();
      return json(res, 200, {
        ok: true,
        tag,
        note: changed
          ? `已保存为「${tag}」—— 原文里的标点/空格被去掉了；存在 tags.manual.json，重新识别覆盖不到`
          : '已保存到 tags.manual.json —— 重新识别不会覆盖它',
      });
    }

    /* ---------- 自动打标签（视觉模型） ---------- */
    if (req.method === 'POST' && p === '/api/sticker/tag') {
      const body = await readBody(req);
      const args = ['tools/tag-stickers.mjs'];
      if (body.force) args.push('--force');
      const dir = resolve(ROOT, 'logs');
      mkdirSync(dir, { recursive: true });
      const logPath = join(dir, 'tag-stickers.log');
      // stdio 用**文件描述符**而不是管道：沙箱下管道会 EPERM，
      // 而且 detached + unref 让识别过程不受面板进程影响。
      const out = openSync(logPath, 'w');
      const child = spawn(process.execPath, args, {
        cwd: ROOT,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', out, out],
      });
      child.unref();
      return json(res, 200, {
        ok: true,
        note: '已开始识别（每张图约 1 秒）。进度在下面，跑完刷新本页就能看到新标签。',
      });
    }

    if (req.method === 'GET' && p === '/api/sticker/taglog') {
      let text = '';
      try {
        text = readFileSync(join(ROOT, 'logs', 'tag-stickers.log'), 'utf8');
      } catch {
        /* 还没跑过 */
      }
      const lines = text.split(/\r?\n/).filter(Boolean);
      return json(res, 200, { ok: true, lines: lines.slice(-40) });
    }

    /* ---------- 立刻试一次主动开口 ---------- */
    if (req.method === 'POST' && p === '/api/proactive/test') {
      const dir = resolve(ROOT, 'logs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ping-now'), String(Date.now()));
      return json(res, 200, {
        ok: true,
        note: '已排队。机器人最多 60 秒内试一次——前提是它跟人有过对话记录（没有会话就没人可发）。',
      });
    }

    /* ---------- 上传表情包压缩包 ---------- */
    if (req.method === 'POST' && p === '/api/sticker/zip') {
      const body = await readBody(req);
      const dataUrl = str(body.data, MAX_BODY);
      if (!dataUrl) return json(res, 400, { ok: false, error: '缺少文件内容' });
      // 浏览器给出的 MIME 五花八门（application/zip、x-zip-compressed、octet-stream），别挑食
      const m = /^data:[^;]*;base64,(.+)$/i.exec(dataUrl);
      if (!m) return json(res, 400, { ok: false, error: '只接受 base64 编码的 zip' });

      const zipBuf = Buffer.from(m[1], 'base64');
      if (zipBuf.length === 0) return json(res, 400, { ok: false, error: '压缩包是空的' });
      if (zipBuf.length > MAX_ZIP) {
        return json(res, 400, { ok: false, error: `压缩包超过 ${Math.round(MAX_ZIP / 1048576)}MB` });
      }

      let entries;
      try {
        entries = readZip(zipBuf);
      } catch (err) {
        return json(res, 400, { ok: false, error: `读不了这个压缩包：${err.message}` });
      }

      const { images, skipped } = pickImages(entries, IMAGE_EXT);
      if (images.length === 0) {
        return json(res, 400, {
          ok: false,
          error: '压缩包里没有可用的图片（支持 png / jpg / jpeg / gif / webp / bmp）',
          skipped: skipped.slice(0, 12),
        });
      }

      mkdirSync(STICKER_DIR, { recursive: true });
      const saved = [];
      const failed = [];
      for (const img of images) {
        const ext = extname(img.file).toLowerCase();
        const stem = basename(img.file, ext).replace(/[[\]/\r\n\\:*?"<>|]/g, '').trim().slice(0, 40);
        if (!stem) {
          failed.push(img.file);
          continue;
        }
        // 重名自动加序号，绝不覆盖你已有的表情包
        let target = join(STICKER_DIR, `${stem}${ext}`);
        let n = 1;
        while (existsSync(target)) {
          target = join(STICKER_DIR, `${stem}-${n}${ext}`);
          n += 1;
        }
        try {
          writeFileSync(target, img.data);
          saved.push(basename(target));
        } catch (err) {
          failed.push(`${img.file}（${err.message}）`);
        }
      }

      return json(res, 200, {
        ok: true,
        saved: saved.length,
        skipped: skipped.slice(0, 12),
        failed: failed.slice(0, 12),
        files: saved.slice(0, 80),
        note: `导入 ${saved.length} 张。重启一次机器人，它才会知道这些新标签。`,
      });
    }

    /* ---------- 删除表情包 ---------- */
    if (req.method === 'POST' && p === '/api/sticker/delete') {
      const body = await readBody(req);
      const file = basename(str(body.file, 120) ?? ''); // basename 挡掉路径穿越
      if (!file || !IMAGE_EXT.has(extname(file).toLowerCase())) return json(res, 400, { ok: false, error: '文件名不合法' });
      const target = join(STICKER_DIR, file);
      if (!existsSync(target)) return json(res, 404, { ok: false, error: '文件不存在' });
      rmSync(target, { force: true });
      return json(res, 200, { ok: true });
    }

    /* ---------- 看表情包 ---------- */
    if (req.method === 'GET' && p.startsWith('/sticker/')) {
      const file = basename(decodeURIComponent(p.slice('/sticker/'.length)));
      const ext = extname(file).toLowerCase();
      if (!IMAGE_EXT.has(ext)) {
        res.writeHead(400);
        res.end('bad ext');
        return;
      }
      const target = join(STICKER_DIR, file);
      if (!existsSync(target)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/png';
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
      res.end(readFileSync(target));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    json(res, 500, { ok: false, error: err.message });
  }
});

/* ------------------------------ 页面 ------------------------------ */

/**
 * ⚠️ 这个页面是 String.raw 模板字符串 —— **内部绝不能出现反引号或 `${`**。
 * 它们会被外层在服务端求值（String.raw 并不阻止插值，只保留反斜杠），
 * 而页面里的变量在模块作用域根本不存在。
 * 上一次就是在这里面写了内层模板字符串，导致服务启动直接 SyntaxError。
 * 需要在页面里拼字符串，一律用 ' + 拼接。
 */
const PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>小笛控制面板</title>
<style>
  :root{color-scheme:dark;--bg:#0f1115;--panel:#161a21;--line:#262c36;--ink:#e6e8ec;--mut:#8b93a1;--acc:#7aa2f7;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  header{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:16px;flex-wrap:wrap;position:sticky;top:0;background:var(--bg);z-index:5}
  h1{font-size:16px;margin:0;font-weight:650}
  .pill{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
  .pill.ok{color:var(--ok);border-color:#1f7a45;background:#0f2a1b}
  .pill.bad{color:var(--bad);border-color:#7a2626;background:#2a1010}
  nav{display:flex;gap:6px;padding:12px 24px 0;flex-wrap:wrap}
  nav button{background:transparent;border:1px solid transparent;color:var(--mut);padding:7px 14px;border-radius:8px;cursor:pointer;font-size:13.5px}
  nav button:hover{color:var(--ink)}
  nav button.on{background:var(--panel);border-color:var(--line);color:var(--ink)}
  main{padding:18px 24px 80px;max-width:900px}
  section{display:none}section.on{display:block}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
  .card h2{font-size:14.5px;margin:0 0 4px;font-weight:650}
  .card p.hint{margin:0 0 14px;color:var(--mut);font-size:12.5px}
  label{display:block;font-size:12.5px;color:var(--mut);margin:12px 0 5px}
  input[type=text],input[type=password],input[type=number],textarea,select{width:100%;background:#0d1014;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px 11px;font:inherit;font-size:13.5px}
  textarea{min-height:150px;resize:vertical;line-height:1.75}
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--acc)}
  .row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1;min-width:180px}
  button.act{background:var(--acc);color:#0b0f16;border:0;border-radius:8px;padding:9px 18px;font-weight:650;cursor:pointer;font-size:13.5px}
  button.act:hover{filter:brightness(1.1)}
  button.act.ghost{background:transparent;border:1px solid var(--line);color:var(--ink);font-weight:500}
  .bar{display:flex;gap:10px;align-items:center;margin-top:16px;flex-wrap:wrap}
  .msg{font-size:12.5px;color:var(--mut)}.msg.ok{color:var(--ok)}.msg.bad{color:var(--bad)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td,th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--mut);font-weight:500;font-size:12px}
  .kv{display:grid;grid-template-columns:150px 1fr;gap:8px 14px;font-size:13.5px}
  .kv div:nth-child(odd){color:var(--mut)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:12px}
  .st{background:#0d1014;border:1px solid var(--line);border-radius:10px;padding:8px;text-align:center;position:relative}
  .st img{width:100%;height:84px;object-fit:contain;display:block;border-radius:6px;background:#fff}
  .st .tag{font-size:12px;margin-top:6px;color:var(--ink)}
  .st .del{position:absolute;top:4px;right:4px;background:#000a;border:1px solid var(--line);color:var(--mut);border-radius:6px;width:22px;height:22px;line-height:1;cursor:pointer;font-size:12px}
  .st .del:hover{color:var(--bad);border-color:var(--bad)}
  .st .edit{position:absolute;top:4px;left:4px;background:#000a;border:1px solid var(--line);color:var(--mut);border-radius:6px;width:22px;height:22px;line-height:1;cursor:pointer;font-size:12px}
  .st .edit:hover{color:var(--acc);border-color:var(--acc)}
  pre{background:#0d1014;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:12.5px;color:var(--mut);white-space:pre-wrap}
  .rec{max-height:340px;overflow:auto}
  .rec .l{color:var(--acc);font-weight:600}.rec .r{color:var(--ok);font-weight:600}
</style></head>
<body>
<header>
  <h1>小笛控制面板</h1>
  <span class="pill" id="pBot">机器人 —</span>
  <span class="pill" id="pOnebot">OneBot —</span>
  <span class="pill" id="pNapcat">NapCat —</span>
  <span class="pill" id="pModel">模型 —</span>
</header>

<nav>
  <button data-t="status" class="on">状态</button>
  <button data-t="persona">人格</button>
  <button data-t="model">模型与密钥</button>
  <button data-t="behave">触发与白名单</button>
  <button data-t="runtime">运行方式</button>
  <button data-t="stickers">表情包</button>
  <button data-t="control">控制</button>
</nav>

<main>
  <!-- 状态 -->
  <section id="status" class="on">
    <div class="card">
      <h2>运行状态</h2>
      <p class="hint">配置改完是<strong>即时生效</strong>的——机器人自己盯着 config.json，不用重启。</p>
      <div class="kv" id="statusKv"></div>
      <div class="bar"><button class="act ghost" id="refresh">刷新</button><span class="msg" id="refreshMsg"></span></div>
    </div>
    <div class="card">
      <h2>最近消息</h2>
      <p class="hint">最多 20 条，机器人重启就清空。</p>
      <div class="rec"><table><tbody id="recentBody"></tbody></table></div>
    </div>
  </section>

  <!-- 人格 -->
  <section id="persona">
    <div class="card">
      <h2>人格设定</h2>
      <p class="hint">这一段就是模型看到的 system prompt 的主体。写"不要什么"比写"要什么"管用；给名字和关系比给形容词稳定。</p>
      <textarea id="personaText" placeholder="你叫小笛……"></textarea>
      <p class="hint" id="personaCount"></p>
      <div class="bar"><button class="act" id="savePersona">保存人格</button><span class="msg" id="personaMsg"></span></div>
    </div>
    <div class="card">
      <h2>机器人实际收到的完整提示词</h2>
      <p class="hint">表情包那段是程序自动接上去的，不在这里改。</p>
      <pre id="effectivePrompt">—</pre>
    </div>
  </section>

  <!-- 模型 -->
  <section id="model">
    <div class="card">
      <h2>模型后端</h2>
      <p class="hint">换后端不需要改代码。<code>echo</code> 只是回显，用来验证链路。</p>
      <div class="row">
        <div><label>provider</label><select id="provider">
          <option value="deepseek">deepseek（云端 API）</option>
          <option value="ollama">ollama（本地模型）</option>
          <option value="echo">echo（回显，仅测试）</option>
        </select></div>
        <div><label>模型名</label><input type="text" id="modelName" placeholder="deepseek-chat / qwen3:8b"></div>
      </div>
      <div class="row">
        <div><label>temperature（越高越跳脱）</label><input type="number" id="temperature" step="0.1" min="0" max="2"></div>
        <div><label>max_tokens（最长回复）</label><input type="number" id="maxTokens" step="64" min="64" max="4096"></div>
      </div>
      <div class="bar"><button class="act" id="saveModel">保存模型设置</button><span class="msg" id="modelMsg"></span></div>
    </div>
    <div class="card">
      <h2>DeepSeek 密钥</h2>
      <p class="hint">只写不读——这个面板<b>不会</b>把已保存的密钥显示出来，任何接口都读不回来。写进 <code>.deepseek-key</code>，机器人每次请求都重读，不用重启。</p>
      <div class="kv" style="margin-bottom:12px"><div>当前状态</div><div id="keyState">—</div></div>
      <label>粘贴新的密钥（会覆盖旧的）</label>
      <input type="password" id="keyInput" placeholder="sk-..." autocomplete="off">
      <div class="bar"><button class="act" id="saveKey">保存密钥</button><span class="msg" id="keyMsg"></span></div>
    </div>
    <div class="card">
      <h2>B站登录（「看视频内容」用）</h2>
      <p class="hint">
        填了它，小笛才能拿到 B站视频的<b>字幕原文</b>——也就是视频里说的话，
        <b>不需要任何语音识别</b>。<br>
        <b>用小号。</b>怎么拿：浏览器登录 bilibili.com → 按 <code>F12</code> → <code>Application</code>
        → 左侧 <code>Cookies</code> → <code>https://www.bilibili.com</code> → 找到 <code>SESSDATA</code>
        → 复制它的 <b>Value</b>，粘到下面。<br>
        只写不读——面板<b>不会</b>回显已保存的内容。写进 <code>bili-cookie.txt</code>，用之前每次重读，不用重启。
      </p>
      <div class="kv" style="margin-bottom:12px"><div>当前状态</div><div id="biliState">—</div></div>
      <label>SESSDATA（登录态：看字幕/详情用；留空＝不改）</label>
      <input type="password" id="biliInput" placeholder="一串很长的字符…" autocomplete="off">
      <label style="margin-top:10px">bili_jct（csrf：点赞/投币/收藏用；留空＝不改）</label>
      <input type="password" id="biliJctInput" placeholder="32 位十六进制…" autocomplete="off">
      <hr style="margin:16px 0;border:none;border-top:1px solid #2a2f3a">
      <h3 style="margin:0 0 6px;font-size:15px">pixiv 登录（搜图 / 下图用；<b>R-18 必须登录</b>）</h3>
      <p class="hint" style="margin:0 0 8px">
        怎么拿：浏览器登录 <code>pixiv.net</code> → <code>F12</code> → <code>Application</code> →
        <code>Cookies</code> → <code>https://www.pixiv.net</code> → 复制 <code>PHPSESSID</code> 的
        <b>Value</b>（想更稳可把 <code>device_token</code> 也填上）。<br>
        ⚠️ <b>pixiv 是 <code>PHPSESSID</code>，B站 才是 <code>SESSDATA</code></b>，别把 B站 那串填到这里。<br>
        ⚠️ 填了也只解决「登录」；<b>R-18 还要去 pixiv 账号设置里把「R-18 / R-18G 作品的显示」打开</b>
        （默认是关的，关着时登录了也搜不到、下不了）。
      </p>
      <div class="kv" style="margin-bottom:12px"><div>pixiv 当前状态</div><div id="pixivState">—</div></div>
      <label>PHPSESSID（留空＝不改）</label>
      <input type="password" id="pixivSessInput" placeholder="一串字符…" autocomplete="off">
      <label style="margin-top:10px">device_token（可选）</label>
      <input type="password" id="pixivDevInput" placeholder="可选，留空也行…" autocomplete="off">
      <div class="bar"><button class="act" id="savePixiv">保存 pixiv 凭证</button><span class="msg" id="pixivMsg"></span></div>
      <div class="bar"><button class="act" id="saveBili">保存 B站 凭证</button><span class="msg" id="biliMsg"></span></div>
      <p class="hint" style="margin-top:10px">
        两个值在<b>同一个 Cookie 列表</b>里（都是 <code>bilibili.com</code> 域下），名字分别是
        <code>SESSDATA</code> 与 <code>bili_jct</code> —— 都只复制 <b>Value</b> 那一列，别把名字一起粘进来。<br>
        ⚠️ <b>在浏览器点「退出登录」会让这串值立刻失效</b>（那正是「退出」的作用）。
        想让它长期可用就<b>别退小号的登录</b>；失效了回来重新粘一次即可。
        关掉浏览器、清缓存通常不影响。
      </p>
    </div>
  </section>

  <!-- 行为 -->
  <section id="runtime">
    <div class="card">
      <h2>运行方式（跑在哪条线上）</h2>
      <p class="hint">
        <b>QQ</b> 走 NapCat（第三方客户端，有被封的风险）；<b>Telegram</b> 走官方 Bot API（不会被封，也不用小号）。
        <br><b>⚠️ 改这一项必须重启机器人</b>——传输层是启动时建的，改完 config.json 不会即时生效（其它配置会即时生效）。
      </p>
      <label>传输层</label>
      <select id="runTransport">
        <option value="onebot">QQ（NapCat / OneBot）</option>
        <option value="telegram">Telegram（官方 Bot API）</option>
      </select>
      <p class="hint" style="margin-top:6px">Telegram 的 token 不放这里、也不放 config.json——它在 <code>qq-bot/telegram-token.txt</code>。</p>
      <div class="row" style="margin-top:10px">
        <div><label>语音嗓子（Windows SAPI 名字）</label><input type="text" id="tgVoiceName" placeholder="Microsoft Yaoyao"></div>
        <div><label>语速（-10 ~ 10）</label><input type="number" id="tgVoiceRate" step="1" min="-10" max="10"></div>
        <div><label>Telegram 长轮询秒数</label><input type="number" id="tgPollSeconds" step="1" min="5" max="50"></div>
      </div>
      <label style="margin-top:10px"><input type="checkbox" id="quoteBack" style="width:auto;margin-right:6px">他引用某条消息时，我也引用回他那条（不勾就不引用）</label>
      <div class="bar"><button class="act" id="saveRuntime">保存</button><span class="msg" id="runtimeMsg"></span></div>
    </div>
  </section>
  <section id="behave">
    <div class="card">
      <h2>什么时候开口</h2>
      <div class="row">
        <div><label>私聊</label><select id="tp"><option value="all">全部回</option><option value="off">不理</option></select></div>
        <div><label>群聊</label><select id="tg">
          <option value="mention">只有被 @ 才回</option><option value="keyword">命中关键词才回</option>
          <option value="all">全部回（容易刷屏）</option><option value="off">不理</option>
        </select></div>
      </div>
      <div class="row">
        <div><label>冷却（毫秒，同一个人两次回复的最小间隔）</label><input type="number" id="cooldown" step="100" min="0" max="60000"></div>
        <div><label>记住几轮对话</label><input type="number" id="turns" step="1" min="0" max="50"></div>
        <div><label>单条回复最长字符</label><input type="number" id="maxReply" step="50" min="50" max="4000"></div>
      </div>
      <label>「主人」这个称呼只给谁（QQ 号，逗号分隔；<b>留空 = 谁都不叫</b>）</label>
      <input type="text" id="masterUsers" placeholder="10000000">
      <label style="margin-top:10px"><input type="checkbox" id="romantic" style="width:auto;margin-right:8px">把主人当<b>恋人</b>（撒娇、吃醋、说甜话）</label>
      <p class="hint" style="margin-top:6px"><b>只影响对上面名单里的人</b>——对其他人一个字都不变（这段是按每条消息的发送者动态注入的）。
      它**叠加**在原有语气上：傲娇/嘴硬/喵/拆段那些规矩照旧，只是嘴硬的含义变成"我其实很高兴"。不写性描写。</p>
      <label>语气风格（叠加在人格之上，**只改怎么说**）</label>
      <select id="toneVibe">
        <option value="genki">元气少女（句首小反应、句尾语气词/波浪号、偶尔小动作）</option>
        <option value="">标准（照人格原本的写法）</option>
      </select>
      <p class="hint" style="margin-top:6px">元气层会拼在提示词的**最末尾**（离对话最近才管用）。它不动篇幅、不动嘴硬频率，
      只是把"唔……有点麻烦诶"这种味道加上去。想更甜/更收敛，直接改 <code>src/addressing.mjs</code> 里那段例子。</p>
      <label>嘴硬频率：每几轮放行一次嘴硬（<b>0 = 从不嘴硬</b>，1 也没什么用）</label>
      <input type="number" id="bratEveryN" min="0" max="20">
      <p class="hint" style="margin-top:8px"><b>这个数字是程序用的，不是让模型数数。</b>实测让模型自己控制频率，它会在「每条都嘴臭」和「一条都不嘴臭」之间来回摆；现在每轮由代码告诉它这条能不能嘴硬，它只负责执行。3 = 大约三分之一。</p>
      <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
      <label><input type="checkbox" id="chatBubbles" style="width:auto;margin-right:8px">像人一样，把回复拆成几条短消息发</label>
      <div class="row">
        <div><label>最多拆几条</label><input type="number" id="chatMax" min="1" max="8"></div>
        <div><label>基础停顿（毫秒）</label><input type="number" id="chatDelay" min="0" max="8000"></div>
        <div><label>每个字再加（毫秒）</label><input type="number" id="chatPerChar" min="0" max="300"></div>
        <div><label>单次停顿上限（毫秒）</label><input type="number" id="chatDelayMax" min="0" max="15000"></div>
        <div><label>一条回复最多发几张网图</label><input type="number" id="chatMaxWeb" min="0" max="9"></div>
      </div>
      <p class="hint" style="margin-top:8px">停顿 = <code>基础 + 字数 × 每字</code>，再夹在上下限之间。
      觉得太快就把<b>基础</b>和<b>每字</b>往上加；觉得等太久就把<b>上限</b>压下来。</p>
      <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
      <label><input type="checkbox" id="voiceEnabled" style="width:auto;margin-right:8px">允许它在群里「说话」（QQ 群 AI 语音）</label>
      <div class="row">
        <div><label>音色 id</label><input type="text" id="voiceCharacter" placeholder="lucy-voice-xueling"></div>
        <div><label>两次语音最小间隔（秒）</label><input type="number" id="voiceGap" min="0" max="3600"></div>
      </div>
      <p class="hint" style="margin-top:8px">用的是 <b>QQ 群自带的 AI 语音</b>（服务端 TTS），<b>不是下载或合成歌曲</b>，
      所以不涉及版权内容。<b>只支持群聊</b>，私聊会自动变成文字。<br>
      常用音色：<code>lucy-voice-xueling</code> 元气少女 ·
      <code>lucy-voice-f38</code> 傲娇少女 · <code>lucy-voice-f36</code> 温柔妹妹 ·
      <code>lucy-voice-female1</code> 邻家小妹 · <code>lucy-voice-daji</code> 妲己 ·
      <code>lucy-voice-laibixiaoxin</code> 小新</p>
      <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
      <label><input type="checkbox" id="musicEnabled" style="width:auto;margin-right:8px">允许它放歌（QQ音乐卡片）</label>
      <div class="row"><div><label>一条回复最多放几首</label><input type="number" id="musicMax" min="0" max="5"></div></div>
      <p class="hint" style="margin-top:8px">它会去 QQ音乐搜歌名（<b>不需要登录</b>）再发卡片。<b>搜不到、或者跟关键词对不上时会问你具体歌名</b>，
      不会瞎放——实测 QQ音乐对任何输入都会返回点东西，所以加了相关性校验。
      梗和歌的对应关系写在<b>梗库</b>里（比如「danking 中路对 zywoo」→《老男孩》）。</p>
      <p class="hint" style="margin-top:8px">按段落拆，<b>长内容不硬切</b>——一整段攻略、清单、数据仍然是一条。
      段数越多越像真人，也越容易触发 QQ 风控，所以上限默认 4。</p>
      <p class="hint" style="margin-top:8px">称呼是<b>按每条消息的发送者动态注入</b>的，不是写死在人格里——所以群里其他人不会被叫「主人」。改完即时生效。</p>
    </div>
    <div class="card">
      <h2>白名单</h2>
      <p class="hint"><b>留空 = 该场景不限制</b>；填了就只理名单里的。多个用逗号或换行分隔。</p>
      <label>私聊白名单（QQ 号）</label>
      <textarea id="wlUsers" style="min-height:70px" placeholder="留空 = 谁都能私聊它"></textarea>
      <label>群白名单（群号）</label>
      <textarea id="wlGroups" style="min-height:70px" placeholder="留空 = 所有群都可以（仍受上面的 @ 限制）"></textarea>
      <div class="bar"><button class="act" id="saveBehave">保存</button><span class="msg" id="behaveMsg"></span></div>
    </div>

    <div class="card">
      <h2>能做的事（工具）</h2>
      <p class="hint">关掉就退回纯聊天。现有工具都是<b>只读、无副作用、不需要密钥</b>的：
      <code>get_weather</code>（实时天气 + 3 天预报）、<code>get_time</code>（当前时间）、
      <code>web_search</code>（Bing 联网搜索）、<code>fetch_page</code>（读某个网页的正文）、
      <code>search_images</code>（搜图，可让机器人直接发出来）、
      <code>search_videos</code>（<b>只给搜索页链接</b>——抓取到的视频结果实测与查询无关，宁可不做也不发假结果）、
      <code>bilibili_search</code>（<b>查梗首选</b>：B站有「网梗指南」「梗百科」这类专门讲梗的 UP，<b>不需要登录</b>）、
      <code>bilibili_hot</code>（B站热搜词 + 热门视频）。
      关掉工具之后，你问它游戏攻略它就只会推脱。<br>
      <b>抓网页有硬防护</b>：只允许 http/https、只走 80/443、<b>本机与内网地址一律拒绝</b>
      （域名解析后还会再查一次，防止用域名指向内网），页面正文最多读 300KB、返回 4000 字。<br>
      <b>发网图</b>：私聊和群里都会发。图片搜索强制开安全搜索；只认<b>本次搜出来的地址</b>
      （模型自己编的不认）；内网地址拒绝；一条回复最多几张在「触发与白名单」里调。<br>
      <b>抖音没接</b>：实测它的网页在未登录时只返回空的 JS 壳，拿不到任何数据。</p>
      <label><input type="checkbox" id="toolsEnabled" style="width:auto;margin-right:8px">允许它调用工具</label>
      <div class="row"><div><label>工具调用最多循环几轮</label><input type="number" id="toolsRounds" min="1" max="8"></div></div>
      <p class="hint" style="margin-top:8px">目前只有 <b>deepseek</b> 这条链路接了 function calling；切到 ollama 或 echo 时工具会自动关掉。</p>
      <div class="bar"><button class="act" id="saveTools">保存</button><span class="msg" id="toolsMsg"></span></div>
    </div>

    <div class="card">
      <h2>梗库（它会优先用这里的梗）</h2>
      <p class="hint">一行一个，格式：<code>梗 —— 什么意思 / 什么时候用</code>。
      以 <code>#</code> 开头的行是注释、以及代码块，都不会接进提示词。<br>
      <b>最有价值的是你们群自己的梗</b>——网络热梗它本来就认识（实测 12 个当前热梗全对），
      但你们群里的黑话、外号、内部典故，它无论如何也猜不到，只有你能告诉它。<br>
      改完点保存，<b>下一条消息就生效，不用重启</b>。梗库会整份接进提示词，所以别写太长
      （超过 2000 字会被截断）。</p>
      <textarea id="memesBox" rows="16" style="width:100%;box-sizing:border-box;font-family:ui-monospace,Consolas,monospace;font-size:13px"></textarea>
      <div class="bar">
        <button class="act" id="saveMemes">保存</button>
        <button class="act" id="reloadMemes">放弃修改，重新载入</button>
        <span class="msg" id="memesMsg"></span>
      </div>
    </div>

    <div class="card">
      <h2>主动开口（长时间没消息时它自己来找你）</h2>
      <p class="hint"><b>默认关闭，我也建议保持保守。</b>平台把"没人叫它却自己发消息"看作典型机器人行为，所以主动消息比被动回复更容易触发风控。免打扰时段是必填项——半夜三点鲸鱼娘来找你，那不是可爱是灾难。</p>
      <label><input type="checkbox" id="paEnabled" style="width:auto;margin-right:8px">开启主动开口</label>
      <div class="row">
        <div><label>安静多少分钟后开口</label><input type="number" id="paAfter" step="10" min="5" max="10080"></div>
        <div><label>两次之间至少隔多少分钟</label><input type="number" id="paGap" step="10" min="5" max="10080"></div>
        <div><label>每天最多几次</label><input type="number" id="paMax" step="1" min="1" max="20"></div>
      </div>
      <div class="row">
        <div><label>免打扰：从（0-23 点）</label><input type="number" id="paQf" min="0" max="23"></div>
        <div><label>免打扰：到（0-23 点）</label><input type="number" id="paQt" min="0" max="23"></div>
      </div>
      <label><input type="checkbox" id="paGroups" style="width:auto;margin-right:8px">也在群里主动开口（不推荐，容易招人烦）</label>
      <div class="bar">
        <button class="act" id="saveProactive">保存</button>
        <button class="act ghost" id="testProactive">立刻试一次</button>
        <span class="msg" id="proactiveMsg"></span>
      </div>
    </div>
  </section>

  <!-- 表情包 -->
  <section id="stickers">
    <div class="card">
      <h2>表情包库</h2>
      <p class="hint">文件名就是标签。模型想发图时会写 <code>[[图:标签]]</code>，程序把它换成真图。<code>大笑-1.png</code> 和 <code>大笑-2.png</code> 都归到标签「大笑」，随机发一张。上传后重启一次机器人，它才知道新标签。<br>
      <b>也支持直接丢一个 zip 进来</b>：把里面的图片批量导入，压缩包内可以带子目录，非图片文件自动跳过，重名自动加序号、不会覆盖你已有的表情包。<br>
      <b>点图片左上角的 ✎ 可以改标签</b>（1–6 个字；留空 = 撤销手改，退回自动识别）。手改的标签单独存在
      <code>tags.manual.json</code>，<b>「全部重新识别」也覆盖不了它</b>。标签角标：<span style="color:var(--ok)">手动</span> /
      <span style="color:var(--acc)">AI</span> / <span style="color:var(--mut)">文件名</span>。</p>
      <label>上传图片或 zip 压缩包（可多选）</label>
      <input type="file" id="up" accept="image/*,.zip,application/zip,application/x-zip-compressed" multiple style="padding:6px 0">
      <div class="bar"><span class="msg" id="upMsg"></span></div>
      <div class="bar">
        <button class="act ghost" id="tagNow">自动识别未打标签的图</button>
        <button class="act ghost" id="tagForce">全部重新识别</button>
        <span class="msg" id="tagMsg"></span>
      </div>
      <pre id="tagLog" style="display:none"></pre>
      <div class="grid" id="stGrid" style="margin-top:16px"></div>
    </div>
  </section>

  <!-- 控制 -->
  <section id="control">
    <div class="card">
      <h2>让它动手（只有主人的私聊能用）</h2>
      <p class="hint">
        这些能力<b>只在你的私聊里</b>存在——群里连工具定义都不会注入，所以群里的人<b>没有入口</b>去诱导它关机、切歌、开程序。<br>
        只读的动作（看状态、读音量）<b>不问你就做</b>；有副作用的动作会先说清楚再动手。
      </p>
      <label><input type="checkbox" id="ctlEnabled" style="width:auto;margin-right:8px">允许它操控这台电脑</label>
      <label style="margin-top:8px"><input type="checkbox" id="ctlReminders" style="width:auto;margin-right:8px">允许它设<b>定时提醒</b>（「X 分钟后提醒我」——真的会响，落盘在 <code>logs/reminders.json</code>）</label>
      <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
      <label>应用白名单（一行一个，<b>名字 = exe 的绝对路径</b>；只写路径也行，名字取文件名）</label>
      <textarea id="ctlApps" style="min-height:90px" placeholder="微信 = C:\Program Files\Tencent\WeChat\WeChat.exe&#10;QQ音乐 = D:\QQMusic\QQMusic.exe"></textarea>
      <p class="hint" style="margin-top:6px"><b>空 = 一个也开不了</b>（不是"全都能开"）。
      它只 spawn 这里写死的绝对路径，<b>不会把模型说的话丢给 shell</b>。</p>
      <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
      <label>文件范围（一行一个目录；<b>下一批</b>「只读文件发我」用，现在填了也还没生效）</label>
      <textarea id="ctlRoots" style="min-height:70px" placeholder="D:\你的目录&#10;C:\你的项目"></textarea>
      <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
      <label>截图黑名单（一行一个进程名关键字，命中就拒绝截那个窗口）</label>
      <textarea id="ctlShotBlock" style="min-height:70px" placeholder="keepass&#10;bitwarden"></textarea>
      <p class="hint" style="margin-top:6px">
        截图<b>不做应用白名单</b>：要截的窗口往往是临时的、事先想不到的（报错框、某个网页）。
        对症的是这份黑名单 + <b>只要窗口不要全屏</b>。
      </p>
      <div class="bar"><button class="act" id="saveControl">保存</button><span class="msg" id="controlMsg"></span></div>
    </div>
    <div class="card">
      <h2>它最近动过什么</h2>
      <p class="hint">每一次操控都写进 <code>logs/control.log</code>（时间 / 谁 / 动作 / 参数 / 结果）。这里显示最后 20 行。</p>
      <pre id="ctlLog">—</pre>
      <div class="bar"><button class="act ghost" id="refreshCtl">刷新</button></div>
    </div>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
let STATE = null;

async function api(path, opts) {
  const r = await fetch(path, { cache: 'no-store', ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
function flash(el, text, ok) {
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'bad');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 6000);
}
const fmtTime = (t) => new Date(t).toLocaleTimeString('zh-CN');

function render() {
  const s = STATE, cfg = s.config ?? {}, st = s.status;
  $('pBot').textContent = st ? '机器人 在线' : '机器人 离线';
  $('pBot').className = 'pill ' + (st ? 'ok' : 'bad');
  $('pOnebot').textContent = 'OneBot ' + (s.ports.onebot ? '已连接' : '未连接');
  $('pOnebot').className = 'pill ' + (s.ports.onebot ? 'ok' : 'bad');
  $('pNapcat').textContent = 'NapCat ' + (s.ports.napcat ? '正常' : '未运行');
  $('pNapcat').className = 'pill ' + (s.ports.napcat ? 'ok' : 'bad');
  const prov = cfg.llm?.provider ?? s.example?.llm?.provider ?? '—';
  $('pModel').textContent = '模型 ' + prov;
  $('pModel').className = 'pill ' + (prov === 'echo' ? '' : 'ok');

  $('statusKv').innerHTML = [
    ['机器人账号', st?.selfId ?? '—'],
    ['当前模型', st ? st.provider + ' / ' + (st.model ?? '—') : '—'],
    ['上线时长', st ? Math.floor((Date.now() - st.startedAt) / 60000) + ' 分钟' : '—'],
    ['DeepSeek 密钥', s.key.configured ? '已配置（' + s.key.source + '）' : '未配置'],
    ['B站 登录', s.bili?.configured ? '已配置（' + s.bili.source + '，' + s.bili.length + ' 字符）' : '未配置 —— 看不了视频里说了什么'],
    ['表情包', (st?.stickers?.tags?.length ?? s.stickers.length) + ' 个标签'],
    ['主动开口', (function () {
      var p = cfg.proactive;
      if (!p || !p.enabled) return '关';
      return '开（安静 ' + p.afterMinutes + ' 分钟后，每天最多 ' + p.maxPerDay + ' 次，' + p.quietHours.from + '-' + p.quietHours.to + ' 点免打扰）';
    })()],
    ['配置文件', s.configFile],
  ].map(([k, v]) => '<div>' + k + '</div><div>' + String(v).replace(/</g, '&lt;') + '</div>').join('');

  const rec = st?.recent ?? [];
  $('recentBody').innerHTML = rec.length
    ? rec.map((r) => '<tr><td style="color:var(--mut);white-space:nowrap">' + fmtTime(r.t) + '</td><td><span class="' + (r.who === '小笛' ? 'r' : 'l') + '">' + r.who + '</span>　' + String(r.text).replace(/</g, '&lt;').slice(0, 160) + (r.images ? ' <span style="color:var(--mut)">［' + r.images + ' 张图］</span>' : '') + '</td></tr>').join('')
    : '<tr><td style="color:var(--mut)">还没有消息</td></tr>';

  $('personaText').value = cfg.llm?.system ?? '';
  if (typeof updatePersonaCount === 'function') updatePersonaCount();
  const tags = st?.stickers?.tags ?? s.stickers.map((x) => x.tag);
  const uniq = [...new Set(tags)];
  $('effectivePrompt').textContent = (cfg.llm?.system ?? '') +
    (uniq.length ? '\n\n你还可以发表情包。想发的时候，在回复里插入标记 [[图:标签]]，可用标签：' + uniq.join('、') + '。…' : '\n\n（表情包库是空的，不会发图）');

  $('provider').value = prov;
  const mp = prov === 'ollama' ? cfg.llm?.ollama : cfg.llm?.deepseek;
  $('modelName').value = mp?.model ?? '';
  $('temperature').value = mp?.temperature ?? 1.0;
  $('maxTokens').value = cfg.llm?.deepseek?.maxTokens ?? 800;
  $('keyState').textContent = s.key.configured ? '已配置 —— ' + s.key.source + '（值不会显示）' : '未配置';
  // 两个口分开报（只报配没配 + 长度，值永不回显）
  var bs = s.bili || {};
  var bSess = bs.sessdata || { configured: false, length: 0, source: '' };
  var bJct = bs.jct || { configured: false, length: 0, source: '' };
  $('biliState').textContent =
    'SESSDATA：' + (bSess.configured ? '已配置（' + (bSess.source || '') + '，' + bSess.length + ' 字符，值不会显示）' : '未配置 —— 拿不到字幕') +
    '　|　bili_jct：' + (bJct.configured ? '已配置（' + bJct.length + ' 字符）' : '未配置 —— 点赞/投币/收藏用不了');
  var ps = s.pixiv || { configured: false, length: 0 };
  if ($('pixivState'))
    $('pixivState').textContent = ps.configured
      ? '已配置（' + ps.length + ' 字符，值不会显示）—— R-18 的查看/下载可用'
      : '未配置 —— R-18 的作品取不到（会报“取不到，或者是 R-18 而我没登录”）';

  $('tp').value = cfg.trigger?.private ?? 'all';
  $('tg').value = cfg.trigger?.group ?? 'mention';
  $('cooldown').value = cfg.limits?.cooldownMs ?? 2500;
  $('turns').value = cfg.limits?.historyTurns ?? 6;
  $('maxReply').value = cfg.limits?.maxReplyChars ?? 900;
  $('wlUsers').value = (cfg.whitelist?.users ?? []).join('\n');
  $('wlGroups').value = (cfg.whitelist?.groups ?? []).join('\n');
  $('masterUsers').value = (cfg.master?.users ?? []).join(', ');
  $('romantic').checked = cfg.master?.romantic === true;
  $('bratEveryN').value = cfg.tone?.bratEveryN ?? 3;
  $('toneVibe').value = cfg.tone?.vibe ?? 'genki';
  $('chatBubbles').checked = cfg.chat?.bubbles !== false;
  $('chatMax').value = cfg.chat?.maxBubbles ?? 4;
  $('chatDelay').value = cfg.chat?.delayMs ?? 1200;
  // ⚠️ 2026-10-15 新增：运行方式的回填（transport / 语音 / 引用）
  $('runTransport').value = cfg.transport === 'telegram' ? 'telegram' : 'onebot';
  $('tgVoiceName').value = cfg.telegram?.voiceName ?? '';
  $('tgVoiceRate').value = cfg.telegram?.voiceRate ?? 2;
  $('tgPollSeconds').value = cfg.telegram?.pollSeconds ?? 10;
  $('quoteBack').checked = cfg.chat?.quoteBack !== false;
  $('chatPerChar').value = cfg.chat?.delayPerChar ?? 45;
  $('chatDelayMax').value = cfg.chat?.delayMax ?? 4500;
  $('chatMaxWeb').value = cfg.chat?.maxWebImages ?? 4;
  $('musicEnabled').checked = cfg.music?.enabled !== false;
  $('musicMax').value = cfg.music?.maxPerReply ?? 1;
  $('voiceEnabled').checked = cfg.voice?.enabled !== false;
  $('voiceCharacter').value = cfg.voice?.character ?? 'lucy-voice-xueling';
  $('voiceGap').value = Math.round((cfg.voice?.minIntervalMs ?? 300000) / 1000);

  const pa = cfg.proactive ?? {};
  $('paEnabled').checked = !!pa.enabled;
  $('paGroups').checked = !!pa.groups;
  $('paAfter').value = pa.afterMinutes ?? 180;
  $('paGap').value = pa.minGapMinutes ?? 240;
  $('paMax').value = pa.maxPerDay ?? 2;
  $('paQf').value = pa.quietHours?.from ?? 23;
  $('paQt').value = pa.quietHours?.to ?? 8;

  $('toolsEnabled').checked = !!cfg.tools?.enabled;
  $('toolsRounds').value = cfg.tools?.maxRounds ?? 4;

  const ctl = cfg.control ?? {};
  $('ctlEnabled').checked = ctl.enabled !== false;
  $('ctlReminders').checked = cfg.reminders?.enabled !== false;
  $('ctlApps').value = appsToText(ctl.apps);
  $('ctlRoots').value = (ctl.files?.roots ?? []).join('\n');
  $('ctlShotBlock').value = (ctl.screenshot?.blocklist ?? []).join('\n');

  $('stGrid').innerHTML = s.stickers.length
    ? s.stickers.map(function (x) {
        var badge = x.byManual
          ? '<span style="color:var(--ok);font-size:11px">手动</span>'
          : x.byVision
            ? '<span style="color:var(--acc);font-size:11px">AI</span>'
            : '<span style="color:var(--mut);font-size:11px">文件名</span>';
        return '<div class="st">'
          + '<button class="edit" data-f="' + encodeURIComponent(x.file) + '" data-t="' + encodeURIComponent(x.tag) + '" title="改标签">&#9998;</button>'
          + '<button class="del" data-f="' + encodeURIComponent(x.file) + '" title="删除">&times;</button>'
          + '<img src="/sticker/' + encodeURIComponent(x.file) + '" alt="">'
          + '<div class="tag">' + x.tag + ' ' + badge + '</div>'
          + '</div>';
      }).join('')
    : '<p class="hint">还没有表情包。上传几张，或者跑 <code>python tools/make-stickers.py</code> 生成一套。</p>';
}

async function load() {
  STATE = await api('/api/state');
  render();
}

const splitList = (v) => v.split(/[\n,，、\s]+/).map((s) => s.trim()).filter(Boolean);
// 路径里**有空格**（Program Files），所以这里只能按行拆，绝不能按空白拆
const splitLines = (v) => String(v ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
/** 「名字 = 路径」→ [{name, path}]；只写路径时名字取文件名（去掉 .exe）。 */
function parseApps(text) {
  return splitLines(text).map(function (line) {
    const i = line.indexOf('=');
    if (i < 0) {
      const base = line.split(/[\\/]/).pop().replace(/\.exe$/i, '');
      return { name: base, path: line };
    }
    return { name: line.slice(0, i).trim(), path: line.slice(i + 1).trim() };
  }).filter(function (a) { return a.path; });
}
function appsToText(apps) {
  return (apps || []).map(function (a) { return (a.name ? a.name + ' = ' : '') + (a.path || ''); }).join('\n');
}

document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('on', s.id === b.dataset.t));
  if (b.dataset.t === 'control') loadControlLog();
});

$('refresh').onclick = async () => { await load(); flash($('refreshMsg'), '已刷新', true); };

/**
 * 人格字数计数器。
 * 为什么要它：旧代码把超长人格**静默截到 4000 字**，用户加了半天发现"加不进去东西"。
 * 现在上限提到 20000，而且**超了直接拒**（不截断）—— 那就必须在界面上让人**看得见**天花板。
 * 注意：这段在 String.raw 模板里，**不能用反引号，也不能写美元大括号插值**（会被服务端求值）。
 * （这个坑我刚又踩了一次 —— 连注释里写上那两种字符都会让页面直接语法错误。）
 */
const PERSONA_MAX = 20000;
function updatePersonaCount() {
  const n = $('personaText').value.length;
  const over = n > PERSONA_MAX;
  $('personaCount').textContent = '当前 ' + n + ' 字 / 上限 ' + PERSONA_MAX + ' 字'
    + (over ? '　⚠️ 超了 ' + (n - PERSONA_MAX) + ' 字，保存会被拒（不会偷偷截断）' : '');
  $('personaCount').style.color = over ? 'var(--bad)' : '';
}
$('personaText').oninput = updatePersonaCount;

$('savePersona').onclick = async () => {
  try {
    await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona: $('personaText').value }) });
    await load(); flash($('personaMsg'), '已保存，机器人已即时生效', true);
  } catch (e) { flash($('personaMsg'), e.message, false); }
};

$('saveModel').onclick = async () => {
  try {
    await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      provider: $('provider').value, model: $('modelName').value,
      temperature: Number($('temperature').value), maxTokens: Number($('maxTokens').value),
    }) });
    await load(); flash($('modelMsg'), '已保存并生效', true);
  } catch (e) { flash($('modelMsg'), e.message, false); }
};

$('saveKey').onclick = async () => {
  const v = $('keyInput').value.trim();
  if (!v) return flash($('keyMsg'), '请先粘贴密钥', false);
  try {
    const r = await api('/api/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: v }) });
    $('keyInput').value = '';
    await load(); flash($('keyMsg'), r.note || '已保存', true);
  } catch (e) { flash($('keyMsg'), e.message, false); }
};

$('saveBili').onclick = async () => {
  // 两个口：留空 = 不改那一项（服务端也照这个规矩），两个都空就本地先拦一次
  const v = $('biliInput').value.trim();
  const j = $('biliJctInput').value.trim();
  if (!v && !j) return flash($('biliMsg'), '两个框都空着 —— 至少填一个（留空的那项保持原样）', false);
  try {
    const r = await api('/api/bili-cookie', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessdata: v, biliJct: j }) });
    if (v) $('biliInput').value = '';
    if (j) $('biliJctInput').value = '';
    await load();
    flash($('biliMsg'), r.note || '已保存', true);
  } catch (e) { flash($('biliMsg'), e.message, false); }
};

// pixiv 单独的保存按钮（2026-10-10 用户要求：两个按钮分开，各管各的）
$('savePixiv').onclick = async () => {
  const px = $('pixivSessInput').value.trim();
  const pxd = $('pixivDevInput').value.trim();
  if (!px) return flash($('pixivMsg'), 'PHPSESSID 空着 —— 至少填这一项（留空的那栏保持原样）', false);
  try {
    const r = await api('/api/bili-cookie', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pixivPhpSess: px, pixivDevice: pxd }),
    });
    $('pixivSessInput').value = '';
    $('pixivDevInput').value = '';
    await load();
    flash($('pixivMsg'), r.pixivNote || '已保存', true);
  } catch (e) { flash($('pixivMsg'), e.message, false); }
};

$('saveRuntime').onclick = async () => {
  try {
    await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      transport: $('runTransport').value,
      voiceName: $('tgVoiceName').value,
      voiceRate: Number($('tgVoiceRate').value),
      pollSeconds: Number($('tgPollSeconds').value),
      quoteBack: $('quoteBack').checked,
    }) });
    await load();
    // ⚠️ 传输层改了必须重启机器人（其它项即时生效）——这句提示不能省，否则用户会以为没生效
    flash($('runtimeMsg'), '已保存。**transport 要重启机器人才生效**（其它项即时生效）', true);
  } catch (e) { flash($('runtimeMsg'), e.message, false); }
};

$('saveBehave').onclick = async () => {
  try {
    await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      triggerPrivate: $('tp').value, triggerGroup: $('tg').value,
      cooldownMs: Number($('cooldown').value), historyTurns: Number($('turns').value), maxReplyChars: Number($('maxReply').value),
      whitelistUsers: splitList($('wlUsers').value), whitelistGroups: splitList($('wlGroups').value),
      masterUsers: splitList($('masterUsers').value),
      romantic: $('romantic').checked,
      bratEveryN: Number($('bratEveryN').value),
      vibe: $('toneVibe').value,
      chat: {
        bubbles: $('chatBubbles').checked,
        maxBubbles: Number($('chatMax').value),
        delayMs: Number($('chatDelay').value),
        delayPerChar: Number($('chatPerChar').value),
        delayMax: Number($('chatDelayMax').value),
        maxWebImages: Number($('chatMaxWeb').value),
      },
      music: { enabled: $('musicEnabled').checked, maxPerReply: Number($('musicMax').value) },
      voice: {
        enabled: $('voiceEnabled').checked,
        character: $('voiceCharacter').value,
        minIntervalMs: Number($('voiceGap').value) * 1000,
      },
    }) });
    await load(); flash($('behaveMsg'), '已保存并生效', true);
  } catch (e) { flash($('behaveMsg'), e.message, false); }
};

$('saveTools').onclick = async () => {
  try {
    await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      tools: { enabled: $('toolsEnabled').checked, maxRounds: Number($('toolsRounds').value) },
    }) });
    await load(); flash($('toolsMsg'), '已保存并即时生效', true);
  } catch (e) { flash($('toolsMsg'), e.message, false); }
};

$('saveControl').onclick = async () => {
  try {
    await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      control: {
        enabled: $('ctlEnabled').checked,
        apps: parseApps($('ctlApps').value),
        files: { roots: splitLines($('ctlRoots').value) },
        screenshot: { blocklist: splitLines($('ctlShotBlock').value) },
      },
      reminders: { enabled: $('ctlReminders').checked },
    }) });
    await load(); flash($('controlMsg'), '已保存并即时生效（不用重启）', true);
  } catch (e) { flash($('controlMsg'), e.message, false); }
};

async function loadControlLog() {
  try {
    const j = await api('/api/controllog');
    $('ctlLog').textContent = (j.lines || []).length ? (j.lines || []).join('\n') : '（还没有任何操控记录）';
  } catch (e) { $('ctlLog').textContent = '读不到日志：' + e.message; }
}
$('refreshCtl').onclick = loadControlLog;

$('saveProactive').onclick = async () => {
  try {
    await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      proactive: {
        enabled: $('paEnabled').checked, groups: $('paGroups').checked,
        afterMinutes: Number($('paAfter').value), minGapMinutes: Number($('paGap').value),
        maxPerDay: Number($('paMax').value),
        quietFrom: Number($('paQf').value), quietTo: Number($('paQt').value),
      },
    }) });
    await load(); flash($('proactiveMsg'), '已保存并即时生效', true);
  } catch (e) { flash($('proactiveMsg'), e.message, false); }
};

$('testProactive').onclick = async () => {
  try {
    const r = await api('/api/proactive/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    flash($('proactiveMsg'), r.note || '已排队', true);
  } catch (e) { flash($('proactiveMsg'), e.message, false); }
};

async function runTagger(force) {
  try {
    const r = await api('/api/sticker/tag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: force }) });
    flash($('tagMsg'), r.note || '已开始', true);
    const log = $('tagLog');
    log.style.display = 'block';
    let n = 0;
    const timer = setInterval(async () => {
      n++;
      try {
        const j = await api('/api/sticker/taglog');
        log.textContent = (j.lines || []).join('\n');
        log.scrollTop = log.scrollHeight;
        if ((j.lines || []).some(function (l) { return l.indexOf('完成：') === 0; })) {
          clearInterval(timer);
          await load();
          flash($('tagMsg'), '识别完成，标签已刷新', true);
        }
      } catch (e) { /* 忽略中间态错误 */ }
      if (n > 60) clearInterval(timer);
    }, 2000);
  } catch (e) { flash($('tagMsg'), e.message, false); }
}
$('tagNow').onclick = function () { runTagger(false); };
$('tagForce').onclick = function () { runTagger(true); };

$('up').onchange = async (ev) => {
  const files = [...ev.target.files];
  if (!files.length) return;
  let saved = 0, zips = 0, notes = [];
  for (const f of files) {
    try {
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      if (/\.zip$/i.test(f.name)) {
        const r = await api('/api/sticker/zip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, data }) });
        saved += r.saved; zips++;
        notes.push(f.name + ' 导入 ' + r.saved + ' 张' + (r.skipped?.length ? '，跳过 ' + r.skipped.length + ' 项' : ''));
      } else {
        await api('/api/sticker', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, data }) });
        saved++;
      }
    } catch (e) { flash($('upMsg'), f.name + '：' + e.message, false); }
  }
  ev.target.value = '';
  await load();
  if (saved) flash($('upMsg'), (notes.length ? notes.join('；') + '。' : '') + '共 ' + saved + ' 张，重启机器人后生效', true);
};

$('stGrid').onclick = async (ev) => {
  const del = ev.target.closest('.del');
  if (del) {
    if (!confirm('删掉这张表情包？')) return;
    try {
      await api('/api/sticker/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: decodeURIComponent(del.dataset.f) }) });
      await load();
    } catch (e) { alert(e.message); }
    return;
  }

  const ed = ev.target.closest('.edit');
  if (!ed) return;
  const file = decodeURIComponent(ed.dataset.f);
  const cur = decodeURIComponent(ed.dataset.t);
  const input = prompt(
    '这张表情包该叫什么？\n（1–6 个字；留空 = 撤销手改，退回自动识别的标签）\n\n文件：' + file,
    cur,
  );
  if (input === null) return;
  try {
    const r = await api('/api/sticker/tag-edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: file, tag: input }) });
    await load();
    flash($('upMsg'), r.note || '已保存', true);
  } catch (e) { alert(e.message); }
};

$('saveMemes').onclick = async () => {
  try {
    const r = await api('/api/memes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: $('memesBox').value }),
    });
    flash($('memesMsg'), r.note || '已保存', true);
  } catch (e) { flash($('memesMsg'), e.message, false); }
};

async function loadMemesBox() {
  try {
    const r = await api('/api/memes');
    $('memesBox').value = r.text ?? '';
  } catch (e) { flash($('memesMsg'), e.message, false); }
}
$('reloadMemes').onclick = loadMemesBox;

load();
loadMemesBox();
setInterval(() => { if (document.getElementById('status').classList.contains('on')) load().catch(() => {}); }, 15000);
</script>
</body></html>`;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      [
        '',
        `❌ 端口 ${PORT} 已被占用。`,
        '   多半是上一个控制面板实例还在跑 —— 注意 DSH 的 job_kill 只杀 pwsh 外壳，',
        '   **不会杀掉 node 子进程**，所以必须按 PID 停：',
        '',
        `     netstat -ano | findstr :${PORT}`,
        '     Stop-Process -Id <上面查到的 PID> -Force',
        '',
      ].join('\n'),
    );
  } else {
    console.error(`❌ 控制面板启动失败：${err.message}`);
  }
  process.exit(1);
});

// 设置 PANEL_NO_LISTEN=1 时只加载不监听 —— 自测靠这个真的把本文件 import 一遍，
// 于是「语法错 / 作用域错导致服务根本起不来」这类问题会被自测抓住。
if (process.env.PANEL_NO_LISTEN === '1') {
  console.log('[panel] 已加载（PANEL_NO_LISTEN=1，未监听）');
} else {
  server.listen(PORT, HOST, () => {
    console.log(`控制面板已启动：http://${HOST}:${PORT}/`);
    console.log(`配置文件：${CONFIG_FILE}`);
    console.log('只监听本机。密钥只进不出，面板不会回显已保存的密钥。');
  });
}

