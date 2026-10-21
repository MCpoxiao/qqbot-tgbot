/**
 * **Telegram 传输层**（2026-10-14 开工，用户决定「那就 tg」）。
 *
 * ## 为什么加它
 * QQ 这条路是**第三方客户端**（NapCat 注入官方 QQNT）：2026-10-13「账号受限→实名」、
 * 10-14「外挂风险被踢下线 1 小时 16 分（那段时间的消息永久丢失 ✗）」。用户问「除了 napcat 还有什么介质稳定」
 * → 结论：**第三方协议端没有一个是真稳的** ✗，真稳只有两条：官方平台（功能大砍 ✗）
 * 或**换平台**（Telegram：Bot API 是官方且鼓励的 ✓、**不会被封** ✓、**不需要第二个号** ✓✓）。
 *
 * ## 设计原则（**人格/记忆/能力一行都不改** ✓）
 * 这个文件**只做"怎么收发"** ✗ —— 对外暴露**和 `src/onebot.mjs` 一样的方法** ✓，
 * 于是 `bot.mjs` 里的东西（人格、记忆、归档、接歌、识图、视频、主动发言、正在输入）**全部原样复用** ✓。
 * 换句话说：`telegram.mjs` 是 OneBot 那层的**同接口替身**，不是另一套机器人 ✗。
 *
 * ## 关键差异（TG 比 QQ 强的地方 ✓）
 * - **打字状态是官方支持** ✓：`sendChatAction('typing')` —— QQ 上折腾半天还是「正在说话」✗；
 * - **主动消息天生可用** ✓（只要用户先跟 bot 说过话）；
 * - **没有登录/扫码/实名/掉登录态** ✗ —— 一个 token 就完事；
 * - **不用第二个号** ✓：bot 是平台里的独立身份（@xxx_bot），用自己账号就能建 ✓。
 *
 * ## 安全底线（**很重要** ✓）
 * **token 绝不进日志、不进记忆、不进归档** ✗ ——
 * 因为 Bot API 的 URL 里**就带着 token**（`https://api.telegram.org/bot<token>/...`），
 * 所以这里所有日志**只打方法名，绝不打 URL** ✓（`#log` 的实现见下）。
 * token 从 `qq-bot/telegram-token.txt`（一行）或环境变量 `TELEGRAM_BOT_TOKEN` 读 ✓。
 *
 * ## 怎么收发
 * - **收**：`getUpdates` **长轮询** ✓（`timeout=25` 秒 ✓）—— 不需要公网地址、不需要 webhook ✓；
 * - **发**：`sendMessage` / `sendPhoto` / `sendDocument` ✓（本地文件走 multipart 上传 ✓）；
 * - **事件形状**：转成**和 OneBot 一样**的形状（`post_type/message_type/user_id/message/sender/...` ✓），
 *   `bot.mjs` 那侧一行为都不用改 ✓。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeVoice } from './tts.mjs';

const API_BASE = 'https://api.telegram.org';

/** 默认轮询超时（秒）—— 比 TG 允许的 50 秒小一点，留余量 ✓。 */
const DEFAULT_POLL_SECONDS = 10;

/** 一个"多行文本 → 数组"的小工具（纯函数，可测）。 */
export function splitText(text, { maxChars = 4000 } = {}) {
  const t = String(text ?? '');
  if (!t) return [];
  if (t.length <= maxChars) return [t];
  const out = [];
  let rest = t;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * **把 Telegram 的一条 message 变成 OneBot 形状的事件**（纯函数，好测 ✓）。
 *
 * 为什么要转：`bot.mjs` 全篇按 OneBot 的事件形状写的（`evt.message_type === 'group'`、
 * `evt.message` 是段数组、`evt.sender.nickname` 取昵称…）✗ —— 转换比改它便宜得多 ✓。
 *
 * @param {object} msg TG 的 `message` 对象
 * @param {object} me  `getMe` 的结果（拿 bot 自己的 id ✓）
 * @param {object} [opts] `{ downloadFile }`：把 file_id 换成**本地路径**的回调（图片/语音/视频 ✓）
 */
export function toOneBotEvent(msg, me = {}, opts = {}) {
  if (!msg || typeof msg !== 'object') return null;
  const chat = msg.chat ?? {};
  const from = msg.from ?? {};
  const isPrivate = chat.type === 'private';
  const text = String(msg.text ?? msg.caption ?? '');
  const segments = [];
  /** 文本里 @bot 的位置 → 转成 OneBot 的 `at` 段（群聊触发逻辑要靠它 ✓）。 */
  const botName = String(me.username ?? '');
  const entities = Array.isArray(msg.entities) ? msg.entities : Array.isArray(msg.caption_entities) ? msg.caption_entities : [];
  const ats = entities
    .map((e) => (e.type === 'mention' || e.type === 'text_mention' ? e : null))
    .filter(Boolean)
    .map((e) => ({ start: e.offset, end: e.offset + e.length, user: e.user?.id ? String(e.user.id) : '' }))
    .sort((a, b) => a.start - b.start);
  // 文本 + @ 段（把 @ 从文本里摘出来，和 OneBot 的行为对齐 ✓）
  let cursor = 0;
  for (const a of ats) {
    if (a.start > cursor) segments.push({ type: 'text', data: { text: text.slice(cursor, a.start) } });
    const who = a.user || (botName && text.slice(a.start, a.end).replace(/^@/, '').trim().toLowerCase() === botName.toLowerCase() ? String(me.id ?? '') : '');
    segments.push({ type: 'at', data: { qq: who } });
    cursor = a.end;
  }
  if (cursor < text.length) segments.push({ type: 'text', data: { text: text.slice(cursor) } });
  // 图片（TG 给多档尺寸，取最大的一档 ✓）
  const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
  if (photo?.file_id) {
    const local = opts.downloadFile ? opts.downloadFile(photo.file_id, 'image') : '';
    segments.push({ type: 'image', data: { file: local ? `file://${local}` : '', url: '', file_id: photo.file_id } });
  }
  if (msg.voice?.file_id) {
    const local = opts.downloadFile ? opts.downloadFile(msg.voice.file_id, 'voice') : '';
    segments.push({ type: 'record', data: { file: local ? `file://${local}` : '', file_id: msg.voice.file_id } });
  }
  if (msg.audio?.file_id || msg.video?.file_id || msg.document?.file_id) {
    const f = msg.audio ?? msg.video ?? msg.document;
    const local = opts.downloadFile ? opts.downloadFile(f.file_id, msg.video ? 'video' : 'file') : '';
    segments.push({
      type: msg.video ? 'video' : 'file',
      data: { file: local ? `file://${local}` : '', name: String(f.file_name ?? ''), file_id: f.file_id },
    });
  }
  /**
   * ⚠️ **引用回复**（2026-10-14 用户要求「引用回复要做」✓）。
   *
   * TG 比 QQ 好用的一点：**被引用的那条消息原文直接就在 update 里** ✓
   * （`reply_to_message` ✓）—— 不需要像 QQ 那样再调 `get_msg` 去查 ✓。
   * 这里把引用做成 OneBot 风格的 `reply` 段 ✓（`data.id` + `data.text` ✓），
   * 于是 bot.mjs 里那套"引用判定 / 引用她的消息就算被叫"的逻辑**原样可用** ✓。
   */
  const quoted = msg.reply_to_message;
  if (quoted?.message_id) {
    const qText = String(quoted.text ?? quoted.caption ?? '').trim();
    segments.push({
      type: 'reply',
      data: {
        id: String(quoted.message_id),
        // 原文直接带上 ✓ —— bot.mjs 优先用它，就不用浪费一次 get_msg ✓
        text: qText.slice(0, 300),
        user_id: String(quoted.from?.id ?? ''),
        nickname: [quoted.from?.first_name, quoted.from?.last_name].filter(Boolean).join('') || String(quoted.from?.username ?? ''),
      },
    });
  }
  if (!segments.length) segments.push({ type: 'text', data: { text: '' } });
  const nickname = [from.first_name, from.last_name].filter(Boolean).join('') || String(from.username ?? '') || String(from.id ?? '');
  return {
    post_type: 'message',
    message_type: isPrivate ? 'private' : 'group',
    sub_type: 'normal',
    self_id: String(me.id ?? ''),
    user_id: String(from.id ?? ''),
    group_id: isPrivate ? undefined : String(chat.id ?? ''),
    message_id: String(msg.message_id ?? ''),
    raw_message: text,
    message: segments,
    sender: {
      user_id: String(from.id ?? ''),
      nickname,
      card: nickname,
      role: 'member',
    },
    time: Number(msg.date ?? Math.floor(Date.now() / 1000)),
    /** 原始 TG 对象：适配层要用（比如回复/引用 ✓），**不参与通用逻辑** ✓。 */
    __tg: { message_id: msg.message_id, chat_id: chat.id, reply_to: msg.reply_to_message?.message_id ?? null },
  };
}

/** 目标 → TG 的 `chat_id`（纯函数 ✓）。 */
export function chatIdFor(target) {
  if (!target) return '';
  if (target.type === 'group') return String(target.id ?? '');
  return String(target.id ?? '');
}

/**
 * **Telegram 传输层**：接口与 `src/onebot.mjs` 的 `OneBot` 对齐 ✓（`on/connect/close/trySend/trySendRich/...`）。
 *
 * 用法（`bot.mjs` 里）：
 * ```js
 * const bot = new Telegram({ tokenFile: 'qq-bot/telegram-token.txt', log, onOutgoing });
 * await bot.connect();
 * ```
 */
export class Telegram {
  /**
   * ⚠️ **私有字段必须先声明**（2026-10-14 我第一版直接 `this.#token = …` ✗ ——
   * JS 里私有字段**不会**像普通属性那样被自动创建 ✓，不声明就是 SyntaxError ✓）。
   */
  #token = '';
  #onOutgoing = null;
  /** `getUpdates` 的游标（确认过的 update_id + 1 ✓）。 */
  #offset = 0;
  /** 自己发出去的消息 id（引用自己/回环判断 ✓），落盘复用 OneBot 那套 ✓。 */
  #own = new Set();
  #failStreak = 0;
  /** 被 `close()` 关掉之后，连接重试与轮询都要停 ✓。 */
  #closed = false;

  constructor({
    token = '',
    tokenFile = 'telegram-token.txt',
    log = console,
    onOutgoing = null,
    pollSeconds = DEFAULT_POLL_SECONDS,
    reconnectMs = 3000,
    maxReconnectMs = 60000,
    ownIdsFile = '',
    spoolDir = 'logs/telegram-spool',
    /** 测试时可以指向 mock 服务 ✓（默认官方地址 ✓）。**不含 token** ✓。 */
    apiBase = API_BASE,
    /** 语音用的嗓子（Windows SAPI 名字 ✓ 默认 Yaoyao ✓）。 */
    voiceName = '',
    /** 语速（SAPI -10..10 ✓）。 */
    voiceRate = 2,
    /** ffmpeg 路径（留空自动找 ✓）。 */
    ffmpeg = '',
  } = {}) {
    this.#token = String(token || '').trim() || Telegram.readToken(tokenFile);
    this.log = log;
    this.#onOutgoing = onOutgoing;
    this.pollSeconds = Math.max(1, Math.min(50, Number(pollSeconds) || DEFAULT_POLL_SECONDS));
    this.reconnectMs = reconnectMs;
    this.maxReconnectMs = maxReconnectMs;
    this.ownIdsFile = ownIdsFile;
    this.spoolDir = spoolDir;
    this.selfId = '';
    this.apiBase = String(apiBase || API_BASE).replace(/\/+$/, '');
    this.voiceName = String(voiceName || '');
    this.voiceRate = Number(voiceRate) || 0;
    this.ttsFfmpeg = String(ffmpeg || '');
    this.url = this.apiBase; // ⚠️ **不含 token**（日志/状态里只会看到这个 ✓）
    this.running = false;
    this.handlers = new Map();
    this.#offset = 0;
    this.#own = new Set();
    this.#failStreak = 0;
    this.#loadOwn();
  }

  /**
   * **从哪儿拿 token**（顺序）——2026-10-14 修：
   *   ① 环境变量 `TELEGRAM_BOT_TOKEN` ✓；
   *   ② 配置里直接写的 `telegram.token`（传进来的 `token` ✓）；
   *   ③ **若干个候选路径**：配置给的（相对 cwd ✓ / 绝对 ✓）、cwd 下的 `telegram-token.txt`、
   *      以及**模块自己所在目录的上一层**（`qq-bot/telegram-token.txt` ✓✓ —— 这条最稳 ✗：
   *      机器人的 cwd 是 `qq-bot/`，以前用 `resolve(cwd, 'qq-bot/telegram-token.txt')` 会拼成
   *      `qq-bot/qq-bot/telegram-token.txt` ✗✗，用户放对了文件也读不到 ✓）。
   * ⚠️ 文件里**以 # 开头**的都当注释 ✓，空文件 = 没配 ✓（所以模板文件可以放心留着 ✓）。
   * 内容**只读一小段**（≤200 字节 ✓），且**绝不回显到日志** ✓。
   */
  static readToken(tokenFile = '') {
    const fromEnv = process.env.TELEGRAM_BOT_TOKEN;
    if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
    const here = dirname(fileURLToPath(import.meta.url)); // qq-bot/src
    const cands = [];
    if (tokenFile) cands.push(isAbsolute(tokenFile) ? tokenFile : resolve(process.cwd(), tokenFile));
    cands.push(resolve(process.cwd(), 'telegram-token.txt'));
    cands.push(resolve(here, '..', 'telegram-token.txt'));
    for (const p of cands) {
      try {
        if (!existsSync(p)) continue;
        const line = readFileSync(p, 'utf8').split(/\r?\n/).map((x) => x.trim()).find((x) => x && !x.startsWith('#'));
        const cand = line.split(/\s+/).pop() ?? ''; // 允许写成「token=xxx」或「token: xxx」或直接一行 ✓
        /**
         * ⚠️ **只认真正的 token 形状**（2026-10-14 加）：真 token 是 `数字:一长串`（必须带冒号 ✓）。
         * 起因：模板文件里我写了句 `token=`，它不是注释 ✗ ⇒ 被当成 token 读出来（6 个字符 ✓），
         * 于是用户会撞一个莫名奇妙的 401 ✗。现在形状不对就当**没配** ✓。
         */
        if (/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(cand)) return cand;
      } catch {
        /* 单个候选读不到就试下一个 ✓ */
      }
    }
    return '';
  }

  #loadOwn() {
    if (!this.ownIdsFile) return;
    try {
      if (!existsSync(this.ownIdsFile)) return;
      for (const id of JSON.parse(readFileSync(this.ownIdsFile, 'utf8'))) this.#own.add(String(id));
    } catch {
      /* 坏了就当空 */
    }
  }

  #saveOwn() {
    if (!this.ownIdsFile) return;
    try {
      const arr = [...this.#own].slice(-500);
      mkdirSync(dirname(this.ownIdsFile), { recursive: true });
      writeFileSync(this.ownIdsFile, JSON.stringify(arr), 'utf8');
    } catch {
      /* 落盘失败不影响运行 */
    }
  }

  /** ⚠️ **只打方法名，绝不打 URL**（URL 里带 token ✗）。 */
  #log(level, msg) {
    const fn = this.log?.[level] ?? this.log?.info;
    try {
      fn?.call(this.log, `[tg] ${msg}`);
    } catch {
      /* 日志失败不能影响运行 */
    }
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
    return this;
  }

  /**
   * ⚠️ **`once` / `off` 必须有**（2026-10-14 补）：这是"和 `OneBot` 同一套接口"的一部分 ✓。
   *
   * 起因：自测里那条 OneBot 端到端写的是 `bot.onebot.once('open', …)` ✓ ——
   * 那次它报 `TypeError: bot.onebot.once is not a function` ✗（真因是**自测配置泄漏** ✓、
   * 让它错建了 TG 传输层 ✗），**但顺手暴露出 `Telegram` 确实没有 `once`** ✓：
   * 只要以后有人写"等一次 ready/open"的代码，换到 TG 就会当场炸 ✗。
   * 现在补齐，并且有断言**逐个比对两边的公开方法** ✓（见自测 ✓）。
   */
  once(event, handler) {
    const wrap = (payload) => {
      this.off(event, wrap);
      return handler(payload);
    };
    return this.on(event, wrap);
  }

  off(event, handler) {
    const list = this.handlers.get(event);
    if (!list) return this;
    this.handlers.set(
      event,
      list.filter((h) => h !== handler),
    );
    return this;
  }

  emit(event, payload) {
    for (const h of this.handlers.get(event) ?? []) {
      try {
        h(payload);
      } catch (err) {
        this.#log('warn', `handler 抛错：${err.message}`);
      }
    }
  }

  /** 调 Bot API。**返回值直接是 result**；失败抛错（错误信息来自 TG，不含 token ✓）。 */
  async callApi(method, params = {}, { timeoutMs = 30000, form = null } = {}) {
    if (!this.#token) throw new Error('没有 Telegram token（放 qq-bot/telegram-token.txt 或设 TELEGRAM_BOT_TOKEN）');
    const url = `${this.apiBase}/bot${this.#token}/${method}`;
    const init = { method: form ? 'POST' : 'POST', signal: AbortSignal.timeout(timeoutMs) };
    if (form) {
      init.body = form;
    } else {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(params);
    }
    let r;
    try {
      r = await fetch(url, init);
    } catch (err) {
      // ⚠️ 这里**不能**把 url 打出去（带 token ✗）
      throw new Error(`${method} 连不上（代理开了吗？）：${err.message}`);
    }
    let j = null;
    try {
      j = await r.json();
    } catch {
      throw new Error(`${method} 返回的不是 JSON（HTTP ${r.status}）`);
    }
    if (!j?.ok) throw new Error(`${method} 失败：${String(j?.description ?? `HTTP ${r.status}`)}`);
    return j.result;
  }

  /**
   * ⚠️ **连接必须自己重试，一次失败不能算完**（2026-10-14 真机修的严重 bug ✗✗）。
   *
   * 起因：今晚 22:07 用户重启之后，日志里**再也没有任何 `[tg]` 行** ✗（连"已连接"都没有 ✓），
   * 他发的图当然也收不到 ✓。查出来两条叠加：
   *   ① `startBot` 里是 `onebot.connect();` —— **没有 await、没有 catch** ✓（fire-and-forget ✓）；
   *   ② 我这个 `connect()` 只调**一次** `getMe` ✓，而实测经代理到 Telegram **三次里就有一次 20 秒超时** ✗
   *      （1.3s ✓ / 20s 超时 ✗ / 1.7s ✓）⇒ 一次失败就**整个传输层废掉** ✗✗，
   *      而且异常没人接 ✓ ⇒ 日志安静得像没事一样 ✓（这正是用户看到的"发了没人理"✓）。
   * 现在：**一直重试到连上为止**（1.5 秒一次 ✓，每 10 次记一行避免刷屏 ✓），
   * 连上之后才开始长轮询 ✓。**消息不会丢** ✓（Telegram 留 24 小时 ✓、offset 只在成功后推进 ✓）。
   */
  async connect() {
    if (this.running) return this;
    if (!this.#token) {
      this.#log('error', '没有 token —— 把 @BotFather 给的 token 写进 qq-bot/telegram-token.txt（一行）');
      return this;
    }
    let tries = 0;
    for (;;) {
      /**
       * ⚠️ **被关掉就立刻停**（2026-10-14 补）：这个重试是"一直试到连上为止" ✓，
       * 若不看 `#closed`，`close()` 之后它还会在后台一直打日志 ✗（测试里尤其难受 ✓）。
       */
      if (this.#closed) return this;
      try {
        const me = await this.callApi('getMe', {});
        this.selfId = String(me.id);
        this.#log('info', `已连接 Telegram：@${me.username ?? '?'}（id ${me.id}）${tries ? `（第 ${tries + 1} 次才成 ✓）` : ''}`);
        this.running = true;
        this.emit('ready', me);
        void this.#pollLoop();
        return this;
      } catch (err) {
        tries += 1;
        if (tries === 1 || tries % 10 === 0) {
          this.#log('warn', `连接失败（第 ${tries} 次，1.5 秒后再试；**消息不会丢**）：${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  async #pollLoop() {
    while (this.running && !this.#closed) {
      try {
        const updates = await this.callApi(
          'getUpdates',
          { offset: this.#offset, timeout: this.pollSeconds, allowed_updates: ['message'] },
          { timeoutMs: (this.pollSeconds + 15) * 1000 },
        );
        /**
         * ⚠️ **轮询恢复要出声**（2026-10-14 加）：失败时用户什么都收不到 ✓，
         * 若成功时也不留痕，事后只能看到一串失败 ✗（今晚就是这样：用户以为"图没发出去"✓）。
         */
        if (this.#failStreak >= 2) this.#log('info', `轮询已恢复（之前连失 ${this.#failStreak} 次）`);
        this.#failStreak = 0;
        for (const u of updates ?? []) {
          this.#offset = Math.max(this.#offset, Number(u.update_id) + 1);
          const msg = u.message ?? u.edited_message;
          if (!msg) continue;
          const evt = toOneBotEvent(msg, { id: this.selfId, username: '' }, {
            // 图片/语音/视频：**先用 file_id 占位**，真正下载交给 bot.mjs 的取图逻辑 ✓
            downloadFile: null,
          });
          if (!evt) continue;
          this.#rememberOwn(String(msg.message_id ?? '')); // bot 自己的消息也记（回环判断 ✓）
          /**
           * ⚠️ **TG 的媒体必须先下到本地**（2026-10-14 本轮补）：
           * TG 的图片/语音/视频只有 file_id ✗（不像 QQ 有公网 URL ✓），
           * 要拿内容得先 getFile 换 file_path，再走 /file/bot<token>/<path> 下载 ✓。
           * 下下来写成 file://路径 ✓ —— bot.mjs 的识图 与 归档 这轮已经支持本地文件了 ✓。
           * ⚠️ 下载 URL 里**带 token** ✗ ⇒ 日志只打「类型 + 大小 + 本地路径」，绝不打 URL ✓。
           */
          await this.#fillLocalMedia(evt);
          this.emit('event', evt);
        }
      } catch (err) {
        if (!this.running) break;
        this.#failStreak += 1;
        /**
         * ⚠️ **长轮询失败要"短平快"重试，不能指数退避到一分钟**（2026-10-14 修 ✗）。
         *
         * 起因：今晚 21:25 之后用户发的消息**一条都没到**（含他发的图 ✓）——
         * 实测代理隧道是**通的**（`CONNECT api.telegram.org:443` 3/3 成功 ✓），
         * 但 **25 秒的长连接**经常被掐 ✗（`fetch failed` / aborted ✓）。而我的重试是
         * `reconnectMs * 2^n`，一路涨到 **60 秒** ✗✗ ⇒ 聊天机器人**动辄睡一分钟** ✓，
         * 用户看到的就是"发出去没人理"✓。
         * 现在：**固定 1.5 秒**重试 ✓（长轮询断掉是**正常事件**，不是"服务挂了"✓），
         * 并且把默认长轮询从 25 秒降到 **10 秒** ✓（暴露窗口更小、恢复更快 ✓）。
         * 好消息：**消息不会丢** ✓ —— Telegram 会把未确认的更新留 24 小时 ✓，
         * 而我们只在**成功处理之后**才推进 offset ✓。
         */
        const wait = this.#failStreak >= 10 ? 15000 : 1500;
        // ⚠️ 2026-10-19：只打 `fetch failed` 看不出根因 ✗ ⇒ 把 cause 的 code 也带上 ✓
        const _cause = err?.cause ? (err.cause.code || err.cause.message || '') : '';
        this.#log('warn', `轮询出错（第 ${this.#failStreak} 次，${wait}ms 后重试；**消息不会丢**，TG 会保留 24 小时）：${err.message}${_cause ? ' / ' + _cause : ''}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  /** 把事件里带 file_id 的媒体段下到本地（失败只记日志，绝不让整条消息挂掉 ✓）。 */
  async #fillLocalMedia(evt) {
    const media = (evt?.message ?? []).filter((s) => s?.data?.file_id && ['image', 'record', 'video', 'file'].includes(s.type));
    for (const s of media) {
      try {
        const got = await this.callApi('getFile', { file_id: s.data.file_id }, { timeoutMs: 20000 });
        const filePath = String(got?.file_path ?? '');
        if (!filePath) throw new Error('没拿到 file_path');
        const dlUrl = this.apiBase + '/file/bot' + this.#token + '/' + filePath; // 带 token，只在本函数内用 ✗
        const r = await fetch(dlUrl, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error('下载 HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) throw new Error('下载到空文件');
        const safe = String(filePath).split('/').pop().replace(/[^\w.-]/g, '_') || 'file';
        const local = join(this.spoolDir, String(Date.now()) + '-' + safe);
        mkdirSync(dirname(local), { recursive: true });
        writeFileSync(local, buf);
        s.data.file = 'file://' + local;
        s.data.url = '';
        this.#log('info', '媒体已下载：' + s.type + ' ' + Math.round(buf.length / 1024) + 'KB（本地 ' + local + '）');
      } catch (err) {
        this.#log('warn', '媒体下载失败（' + s.type + '）：' + err.message);
      }
    }
  }

  #rememberOwn(id) {
    if (!id) return;
    this.#own.add(String(id));
    if (this.#own.size % 20 === 0) this.#saveOwn();
  }

  /** 这条消息是不是我自己发的（引用自己/回环判断用 ✓）—— 与 OneBot 语义一致 ✓。 */
  isOwnMessage(id) {
    return this.#own.has(String(id));
  }

  // ───────────────────────── 发送 ─────────────────────────

  async sendPrivate(userId, text) {
    const r = await this.callApi('sendMessage', { chat_id: String(userId), text: String(text ?? '') });
    this.#rememberOwn(String(r?.message_id ?? ''));
    this.emit('outgoing', { target: { type: 'private', id: String(userId) }, segments: [{ type: 'text', text: String(text ?? '') }], id: String(r?.message_id ?? '') });
    return r;
  }

  async sendGroup(groupId, text) {
    const r = await this.callApi('sendMessage', { chat_id: String(groupId), text: String(text ?? '') });
    this.#rememberOwn(String(r?.message_id ?? ''));
    return r;
  }

  async trySend(target, text) {
    try {
      await this.callApi('sendMessage', { chat_id: chatIdFor(target), text: String(text ?? '') });
      return true;
    } catch (err) {
      this.#log('warn', `发送失败：${err.message}`);
      return false;
    }
  }

  /**
   * **发"富消息"**（文本/图片/文件混排 ✓）—— 与 OneBot 的 `trySendRich` 同名同语义 ✓。
   *
   * 段形状按项目的内部约定（`{type:'text', text}` / `{type:'image', file|path|url}` ✓）。
   * 一段一条消息（TG 没有 CQ 那种一次多段的概念 ✓），段间留一点间隔更像人 ✓。
   */
  async trySendRich(target, segments, { gapMs = 350, replyTo = '' } = {}) {
    const chat_id = chatIdFor(target);
    const list = Array.isArray(segments) ? segments : [];
    /**
     * **引用回复**：`replyTo` 是"要引用的那条消息 id" ✓（bot.mjs 传进来 ✓）。
     * `allow_sending_without_reply` 很重要：万一那条被删了 ✓，消息**照样发出去** ✓
     * —— 不能因为引用的目标没了就整条失败 ✗。
     */
    const quote = replyTo ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {};
    let sent = 0;
    for (const s of list) {
      const type = String(s?.type ?? 'text');
      try {
        if (type === 'text') {
          const text = String(s.text ?? '');
          if (!text.trim()) continue;
          for (const chunk of splitText(text)) {
            const r = await this.callApi('sendMessage', { chat_id, text: chunk, ...(sent ? {} : quote) });
            this.#rememberOwn(String(r?.message_id ?? ''));
            sent += 1;
          }
        } else if (type === 'image') {
          /**
           * ⚠️ **图片有三种来源，都要能发**（2026-10-14 真机补 ✓）：
           *   ① **本地文件**（`file://…`，TG 收到的图 / 视频抽帧 ✓）；
           *   ② **http(s) URL**（`buildRichSegments` 把网图发成 `{type:'image', file:'http://…'}` ✓ ——
           *      **冲浪发图就是这条** ✓，第一版我只认本地文件和 `s.url` ✗ ⇒ 直接跳过 ✓，
           *      日志里就是那句「这张图既没有本地文件也没有 URL，跳过」✗）；
           *   ③ **`base64://…`**（QQ 那边本地图走这个 ✓ —— 不处理的话"她发本地图"在 TG 上会静默丢 ✗）。
           * TG 自己会去抓 URL ✓，所以 ② 直接把链接交给它；①③ 走 multipart 上传 ✓。
           */
          const raw = String(s.path ?? s.file ?? '');
          const fromUrl = /^https?:\/\//i.test(raw) ? raw : /^https?:\/\//i.test(String(s.url ?? '')) ? String(s.url) : '';
          const local = raw.replace(/^file:\/\//, '');
          if (fromUrl) {
            const r = await this.callApi('sendPhoto', { chat_id, photo: fromUrl }, { timeoutMs: 60000 });
            this.#rememberOwn(String(r?.message_id ?? ''));
            sent += 1;
          } else if (raw.startsWith('base64://')) {
            const buf = Buffer.from(raw.slice('base64://'.length), 'base64');
            if (!buf.length) throw new Error('base64 图是空的');
            const form = new FormData();
            form.append('chat_id', chat_id);
            form.append('photo', new Blob([buf]), 'photo.jpg');
            const r = await this.callApi('sendPhoto', {}, { form, timeoutMs: 60000 });
            this.#rememberOwn(String(r?.message_id ?? ''));
            sent += 1;
          } else if (local && existsSync(local)) {
            const form = new FormData();
            form.append('chat_id', chat_id);
            form.append('photo', new Blob([readFileSync(local)]), local.split(/[\\/]/).pop() || 'photo.jpg');
            const r = await this.callApi('sendPhoto', {}, { form, timeoutMs: 60000 });
            this.#rememberOwn(String(r?.message_id ?? ''));
            sent += 1;
          } else {
            /**
             * 真的什么都没有 ⇒ 报警要**带上段里的键** ✓（第一版只写"既没有本地文件也没有 URL"✗，
             * 结果排查时看不出到底是哪种形状 ✓ —— 今天真机就靠这句话才发现是 `file: 'http://…'` ✓）。
             */
            this.#log('warn', `这张图发不出去：段里的键是 ${Object.keys(s).join('/')}，file=${raw.slice(0, 60)}`);
          }
        } else {
          this.#log('info', `暂不支持发 ${type} 段（TG 版先做文字/图片 ✓）`);
        }
      } catch (err) {
        this.#log('warn', `发 ${type} 段失败：${err.message}`);
      }
      if (sent && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    }
    const ok = sent > 0;
    if (ok) {
      try {
        this.#onOutgoing?.(target, list, '');
      } catch {
        /* 归档回调抛错不影响发送 */
      }
      this.#saveOwn();
    }
    return ok;
  }

  /**
   * **打字状态**（TG 上这是**官方能力** ✓ —— QQ 那边折腾半天还是「正在说话」✗）。
   * `eventType` 为了和 OneBot 的调用点兼容而保留：非 0 就发 typing ✓，0 忽略（TG 没有"取消"✓）。
   */
  async setInputStatus(userId, eventType = 1) {
    if (Number(eventType) === 0) return true;
    try {
      await this.callApi('sendChatAction', { chat_id: String(userId), action: 'typing' });
      return true;
    } catch (err) {
      this.#log('debug', `sendChatAction 失败（不影响发消息）：${err.message}`);
      return false;
    }
  }

  // ───────── 以下是与 OneBot 同名的"QQ 专属能力"，TG 版给**诚实的降级** ✓ ─────────

  /**
   * ⚠️ **通用 API 入口 `call(action, params)`**（2026-10-14 补，为接口对齐 ✓）。
   *
   * `bot.mjs` 里有一处 `onebot.call('get_msg', { message_id }, 8000)` ✓（引用某条消息时去查原文 ✓）——
   * 那是 OneBot 的通用入口 ✓，TG 版没有它的话**引用回复那条路会直接抛** ✗。
   * 这里把**真正用得上**的几个动作映射过去 ✓，其它一律**诚实返回空 + 记一行** ✓
   * （宁可"查不到"也不假装成功 ✗）。
   */
  async call(action, params = {}, timeoutMs = 20000) {
    const act = String(action ?? '');
    if (act === 'get_msg') {
      // TG 的 getUpdates 只给"新消息"✓，历史消息要另存 —— 这里如实说"拿不到原文" ✓
      this.#log('info', 'get_msg：TG 拿不到历史消息原文（引用回复会退化成不带原文）');
      return null;
    }
    if (act === 'set_input_status') return this.setInputStatus(params.user_id ?? params.userId, params.event_type ?? 1);
    if (act === 'get_group_list') return this.getGroupList();
    if (act === 'get_login_info') return { user_id: this.selfId, nickname: '' };
    this.#log('info', `未映射的 API：${act}（TG 版按"做不到"处理，返回空）`);
    return null;
  }

  async getGroupList() {
    this.#log('info', 'TG 版没有"群列表"这个概念（bot 只能看到自己所在的群，且要先被加进去）');
    return [];
  }

  async setGroupLeave() {
    this.#log('info', 'TG 版退群要用 leaveChat，暂未接（需要时再加 ✓）');
    return false;
  }

  /**
   * **发一条语音**（2026-10-14 用户要求「语音发送要做」✓）。
   *
   * 链路：**本地 SAPI 合成 → ffmpeg 转 ogg/opus → sendVoice** ✓
   * （Telegram 的语音消息**必须是 ogg/opus** ✓，所以中间那步不能省 ✓）。
   * 全程离线、免费、不需要 key ✓。
   *
   * ⚠️ **失败一律降级成文字** ✓：语音只是"多一个表达方式" ✓，
   * 合成不出来（没装语音包 / 沙箱限制 / ffmpeg 不在 ✓）时**必须还能说话** ✗ ——
   * 而且要把**真实原因**记进日志 ✓（别让下次又只能猜 ✓）。
   */
  async sendAiVoice(target, text) {
    let tts = null;
    try {
      tts = await synthesizeVoice(text, {
        log: this.log,
        ffmpeg: this.ttsFfmpeg,
        ...(this.voiceName ? { voice: this.voiceName } : {}),
        rate: this.voiceRate,
      });
    } catch (err) {
      this.#log('warn', '语音合成失败 → 降级发文字：' + err.message);
      return this.trySend(target, text);
    }
    try {
      const form = new FormData();
      form.append('chat_id', chatIdFor(target));
      form.append('voice', new Blob([readFileSync(tts.file)]), 'voice.ogg');
      const r = await this.callApi('sendVoice', {}, { form, timeoutMs: 60000 });
      this.#rememberOwn(String(r?.message_id ?? ''));
      this.#log('info', '语音已发出：' + tts.text.slice(0, 30) + '（' + Math.round(tts.bytes / 1024) + 'KB）');
      return true;
    } catch (err) {
      this.#log('warn', 'sendVoice 失败 → 降级发文字：' + err.message);
      return this.trySend(target, text);
    } finally {
      try {
        rmSync(tts.file, { force: true });
      } catch {
        /* 删不掉不影响 ✓ */
      }
    }
  }

  async getAiCharacters() {
    return [];
  }

  async uploadFile(target, { file, name } = {}) {
    const local = String(file ?? '').replace(/^file:\/\//, '');
    if (!local || !existsSync(local)) throw new Error('要发的文件不存在');
    const form = new FormData();
    form.append('chat_id', chatIdFor(target));
    form.append('document', new Blob([readFileSync(local)]), String(name || local.split(/[\\/]/).pop() || 'file'));
    const r = await this.callApi('sendDocument', {}, { form, timeoutMs: 120000 });
    this.#rememberOwn(String(r?.message_id ?? ''));
    return r;
  }

  async close() {
    this.running = false;
    this.#closed = true;
    this.#saveOwn();
    return this;
  }
}
