import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * OneBot 11 客户端（正向 WebSocket）。
 *
 * 这里刻意只依赖 Node 内置的全局 WebSocket——不装任何包。
 * 因此鉴权只能走两种方式：URL 查询参数 access_token，或由 undici 支持的 headers 选项。
 * 本机 127.0.0.1 场景建议 NapCat 那边不设 token；若要设 token，见 README 的说明。
 */
export class OneBot extends EventEmitter {
  constructor({ url, token = '', reconnectMs = 3000, maxReconnectMs = 60000, ownIdsFile = '', onOutgoing = null } = {}) {
    super();
    this.baseUrl = url;
    this.token = token;
    this.reconnectMs = reconnectMs;
    this.maxReconnectMs = maxReconnectMs;
    this.selfId = null;
    this.ws = null;
    this.pending = new Map();
    this.echoSeq = 0;
    this.attempt = 0;
    this.closedByUs = false;
    this.lastEventAt = 0;
    this.timer = null;
    /**
     * **发出去的消息的钩子**（2026-10-11 加，给 7 天聊天归档用）：
     * 挂在 OneBot 这一层是**唯一不漏**的位置 —— 文本、富消息、主动开口、文件上传全从这里出去。
     * 回调里抛错不影响发送（见 `#notifyOutgoing`）。
     */
    this.#onOutgoing = typeof onOutgoing === 'function' ? onOutgoing : null;
    // "我发过哪些消息"落盘（认群里的引用用）——见 #loadOwnIds
    this.#ownIdsFile = ownIdsFile ? String(ownIdsFile) : '';
    this.#loadOwnIds();
  }

  /**
   * 自己发出去的消息 id（有上限）。用途：**群里引用机器人的话也算被叫** —— 见 router.mjs。
   *
   * ⚠️ 2026-10-09 修两个 bug（用户报「引用的逻辑还有点问题」）：
   *  ① **只有富消息那条路在记**：`sendPrivate` / `sendGroup`（她绝大多数回复都是纯文本）
   *     从来没记过 id → 群里引用她的**文字回复**根本不算"在跟她说话"；
   *  ② **只在内存里**：一重启全忘（用户当天重启了 5 次）→ 之前的消息全认不出来。
   * 现在：两条路都记，并且**落盘**（`logs/own-ids.json`，只留最近 500 条）。
   */
  #ownIds = new Set();

  #ownIdsFile = '';

  #ownIdsDirty = false;

  /** 发出去的消息钩子（7 天聊天归档用；见构造函数注释）。 */
  #onOutgoing = null;

  /** 报告一条"我们发出去的"消息（带上它的 `message_id`，别人引用它时归档能查回原文）。**回调抛错绝不能影响发送**。 */
  #notifyOutgoing(target, segments, id = '') {
    if (!this.#onOutgoing) return;
    try {
      this.#onOutgoing(target, segments, id);
    } catch (err) {
      this.#log('warn', `归档钩子出错（不影响发送）：${err.message}`);
    }
  }

  /** 从磁盘读回"我发过哪些消息"（重启后仍然认得出被引用的是我的话）。 */
  #loadOwnIds() {
    if (!this.#ownIdsFile) return;
    try {
      if (!existsSync(this.#ownIdsFile)) return;
      const j = JSON.parse(readFileSync(this.#ownIdsFile, 'utf8'));
      if (Array.isArray(j?.ids)) for (const id of j.ids) this.#ownIds.add(String(id));
    } catch {
      /* 坏了就当空的：这只是"认引用"的辅助信息，不值得让它崩 */
    }
  }

  #saveOwnIds() {
    if (!this.#ownIdsFile || !this.#ownIdsDirty) return;
    try {
      mkdirSync(dirname(this.#ownIdsFile), { recursive: true });
      writeFileSync(this.#ownIdsFile, `${JSON.stringify({ ids: [...this.#ownIds], at: Date.now() })}\n`, 'utf8');
      this.#ownIdsDirty = false;
    } catch {
      /* 写不进去也不能影响发消息 */
    }
  }

  #rememberOwn(id) {
    const k = String(id ?? '');
    if (!k) return;
    this.#ownIds.add(k);
    // 上限放宽到 500（原来 80 太小：一条长回复分 4 段就吃掉 4 个名额）
    while (this.#ownIds.size > 500) this.#ownIds.delete(this.#ownIds.values().next().value);
    this.#ownIdsDirty = true;
    // 落盘别太勤：攒 2 秒
    if (this.#ownIdsTimer) clearTimeout(this.#ownIdsTimer);
    this.#ownIdsTimer = setTimeout(() => this.#saveOwnIds(), 2000);
    this.#ownIdsTimer.unref?.();
  }

  #ownIdsTimer = null;

  /** 这条消息是不是我自己发的（用来判断群里「引用回复」是不是在跟我说话）。 */
  isOwnMessage(id) {
    return this.#ownIds.has(String(id ?? ''));
  }

  #log(level, msg) {
    this.emit('log', { level, msg });
  }

  #targetUrl() {
    if (!this.token) return this.baseUrl;
    const u = new URL(this.baseUrl);
    if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', this.token);
    return u.toString();
  }

  connect() {
    this.closedByUs = false;
    const target = this.#targetUrl();
    let ws;
    if (this.token) {
      try {
        // undici 的 WebSocket 支持 { headers } 扩展；万一这个版本不支持就退化为 URL 上的 access_token。
        ws = new WebSocket(target, { headers: { authorization: `Bearer ${this.token}` } });
      } catch {
        ws = new WebSocket(target);
      }
    } else {
      ws = new WebSocket(target);
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.lastEventAt = Date.now();
      this.#log('info', `已连接到 OneBot: ${this.baseUrl}`);
      this.emit('open');
    });

    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));

    ws.addEventListener('error', (ev) => {
      this.#log('warn', `连接出错：${ev?.message ?? ev?.error?.message ?? 'unknown'}`);
    });

    ws.addEventListener('close', (ev) => {
      const detail = `code=${ev?.code ?? '?'} reason=${ev?.reason || '-'}`;
      this.#log('warn', `连接断开（${detail}）`);
      this.#failAllPending(new Error(`连接已断开（${detail}）`));
      this.emit('close', ev);
      if (!this.closedByUs) this.#scheduleReconnect();
    });

    return this;
  }

  #scheduleReconnect() {
    this.attempt += 1;
    const wait = Math.min(this.reconnectMs * 2 ** (this.attempt - 1), this.maxReconnectMs);
    this.#log('info', `${wait}ms 后重连（第 ${this.attempt} 次）`);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.closedByUs) this.connect();
    }, wait);
  }

  #failAllPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  #onMessage(raw) {
    this.lastEventAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      this.#log('warn', '收到无法解析的消息，已丢弃');
      return;
    }

    if (msg.echo !== undefined && this.pending.has(msg.echo)) {
      const p = this.pending.get(msg.echo);
      this.pending.delete(msg.echo);
      clearTimeout(p.timer);
      if (msg.status === 'ok' || msg.retcode === 0) p.resolve(msg.data);
      else p.reject(new Error(`API 失败 action=${p.action} retcode=${msg.retcode} ${msg.message ?? msg.wording ?? ''}`));
      return;
    }

    if (msg.post_type === 'meta_event' && msg.meta_event_type === 'lifecycle' && msg.self_id) {
      this.selfId = String(msg.self_id);
      this.#log('info', `协议端就绪，机器人 QQ：${this.selfId}`);
    }
    if (msg.self_id) this.selfId = String(msg.self_id);

    this.emit('event', msg);
  }

  /**
   * **设置"正在输入"状态**（2026-10-12 加）。
   *
   * 用户原话：「我看网上说要有**对方正在输入**才可以避免」——指的是"让她在回复前先显示正在输入，
   * 这样行为更像人、降低被风控判定成机器人的概率"。
   *
   * 事实核查：
   *   · NapCat **确实支持** `set_input_status`（参数 `user_id` + `event_type`）——
   *     见官方 [NapCatQQ API 文档](https://napneko.github.io/onebot/api)；
   *   · **但"能防封"这件事我无法证实**（社区说法，没有官方依据）✗ ——
   *     它属于"增加人类信号"这一类，方向合理、成本极低、没有副作用，所以值得做；
   *     **但别把它当护身符**（真正的风险来自"第三方客户端挂机"本身）。
   *   · `event_type` 的取值**官方文档没列**（只写 `event_type: number`）✗。
   *     **⚠️ 至今没查清，如实记录（2026-10-13）**：
   *       - 2026-10-12 22:13 连发 `1` 90 秒 → 用户回「有了」，我当成"正在输入"；
   *       - 23:24 用户纠正：「**是对方正在说话**」✗；
   *       - 10-13 18:13 做阶段实验（单发 `1` 40 秒 / 单发 `2` 40 秒）后，用户反馈
   *         「**他这个状态有滞后性**，我 18:18 了都能看见」+「**状态这个就不改了吧，也没啥影响**」。
   *     ⇒ **结论：`1` 的显示不稳定**（用户先后看到过"正在输入"和"正在说话"，且**明显滞后**于调用），
   *       机制未查明；**用户已决定不改**（`typingIndicator: true` / `typingEventType: 1` 保持原样 ✓）。
   *       **别再花时间在这上面**，也别把任何一个取值写成"实测确认"（三种说法都被推翻过 ✗）。
   *   · 另：`0` = 收掉状态 ✓（这个没问题）。
   *
   * **绝不抛错、绝不阻塞**：这只是个装饰性状态，失败了不该影响发消息。
   */
  async setInputStatus(userId, eventType = 1) {
    const id = String(userId ?? '').trim();
    if (!id) return false;
    try {
      await this.call('set_input_status', { user_id: Number(id) || id, event_type: Number(eventType) || 0 }, 5000);
      return true;
    } catch (err) {
      // 只是状态提示，失败就静默（除非要排查：调用方自己决定要不要记日志）
      this.emit('log', { level: 'debug', msg: `set_input_status 失败（不影响发消息）：${err.message}` });
      return false;
    }
  }

  /** 调 OneBot 接口，按 echo 匹配响应。 */
  call(action, params = {}, timeoutMs = 20000) {    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`未连接，无法调用 ${action}`));
    }
    const echo = `e${Date.now().toString(36)}-${this.echoSeq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`调用 ${action} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer, action });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  async sendPrivate(userId, text) {
    const r = await this.call('send_private_msg', { user_id: Number(userId), message: text });
    // ⚠️ 这里原来**不记 id** → 群里引用她的**文字回复**不算被叫（2026-10-09 的 bug 之一）
    this.#rememberOwn(r?.message_id);
    // 纯文本这条路也要进归档（她的回复绝大多数是纯文本 —— 漏了它归档就只有一半）
    this.#notifyOutgoing({ type: 'private', id: userId }, [{ type: 'text', data: { text: String(text ?? '') } }], r?.message_id);
    return r;
  }

  async sendGroup(groupId, text) {
    const r = await this.call('send_group_msg', { group_id: Number(groupId), message: text });
    this.#rememberOwn(r?.message_id);
    this.#notifyOutgoing({ type: 'group', id: groupId }, [{ type: 'text', data: { text: String(text ?? '') } }], r?.message_id);
    return r;
  }

  /** 取机器人所在的群列表（`[{group_id, group_name, member_count}]`）。失败返回 []。 */
  async getGroupList() {
    try {
      const r = await this.call('get_group_list', {});
      const data = r?.data ?? r;
      return Array.isArray(data) ? data : [];
    } catch (err) {
      this.#log('warn', `取群列表失败：${err.message}`);
      return [];
    }
  }

  /** 退出某个群。**不可逆**：要别人重新邀请才能回去。 */
  async setGroupLeave(groupId) {
    try {
      await this.call('set_group_leave', { group_id: Number(groupId) });
      return true;
    } catch (err) {
      this.#log('warn', `退群失败：${err.message}`);
      return false;
    }
  }

  /**
   * 发一条 **AI 语音**：把文字交给 QQ 自带的 TTS 念出来。
   *
   * 这不是我们自己合成或下载音频，而是**触发 QQ 的 AI 语音功能**——
   * 所以这条路径不涉及任何版权内容（跟"下载会员歌曲再转发"是两回事）。
   *
   * 群聊和私聊走的是**两条不同的路**：
   *   - 群聊：`send_group_ai_record` 直接发；
   *   - 私聊：QQ **没有**私聊 AI 语音动作，但 `get_ai_record` 能生成音频并返回地址
   *     （它要 `group_id`，所以得给一个机器人所在的群当 fallback），
   *     拿到 URL 之后再当 `record` 段发给对方。
   */
  async sendAiVoice(target, text, character, { fallbackGroupId } = {}) {
    const t = String(text ?? '').trim();
    if (!t || !character || !target) return false;
    const clipped = t.slice(0, 200);

    if (target.type === 'group') {
      try {
        await this.call('send_group_ai_record', { group_id: Number(target.id), character, text: clipped }, 40000);
        return true;
      } catch (err) {
        this.#log('warn', `群语音失败：${err.message}`);
        return false;
      }
    }

    const gid = Number(fallbackGroupId);
    if (!gid) {
      this.#log('warn', '私聊发语音需要一个 fallbackGroupId（get_ai_record 必须带 group_id）');
      return false;
    }
    try {
      const r = await this.call('get_ai_record', { group_id: gid, character, text: clipped }, 40000);
      // ⚠️ call() 已经解包出 msg.data（见 #onMessage），所以这里拿到的**就是 URL 字符串本身**。
      // 曾写成 `typeof r?.data === 'string' ? r.data : (r?.data?.url ?? r?.data?.file)`——
      // 那是在按**未解包**的响应取值，于是永远拿不到 URL，私聊语音一直静默降级成文字，
      // 还被误记成「QQ 不支持私聊 AI 语音」（2026-10-07 实测纠正）。
      const data = r?.data ?? r; // 与 getGroupList / getAiCharacters 保持同一种兼容写法
      const url = typeof data === 'string' ? data : (data?.url ?? data?.file);
      if (!url) throw new Error(`没拿到音频地址（返回：${JSON.stringify(data)?.slice(0, 200)}）`);
      await this.call(
        'send_private_msg',
        { user_id: Number(target.id), message: [{ type: 'record', data: { file: url } }] },
        40000,
      );
      return true;
    } catch (err) {
      this.#log('warn', `私聊语音失败：${err.message}`);
      return false;
    }
  }

  /** 取某个群可用的 AI 音色列表（`[{type, characters:[{character_id,character_name}]}]`）。失败返回 []。 */
  async getAiCharacters(groupId) {
    try {
      const r = await this.call('get_ai_characters', { group_id: Number(groupId) });
      const data = r?.data ?? r;
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /** 不抛错的发送，返回是否成功，方便在事件回调里用。 */
  async trySend(target, text) {
    try {
      if (target.type === 'group') await this.sendGroup(target.id, text);
      else await this.sendPrivate(target.id, text);
      return true;
    } catch (err) {
      this.#log('error', `发送失败：${err.message}`);
      return false;
    }
  }

  /** 发一条富消息：文本和图片混在同一条里（OneBot 的段数组格式）。 */
  async trySendRich(target, segments) {
    const isGroup = target.type === 'group';
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const build = (segs) =>
      segs.map((s) => {
        if (s.type === 'music') {
          // ⚠️ **必须带上 title 等字段**，不能只给 {type,id}。
          // NapCat 是把这些字段 POST 给第三方「音乐卡片签名服务」来拼卡片的，
          // 只给 {type:'qq', id} 会被对方判 400「缺少 title」→ 签名失败 →
          // 卡片被静默丢掉，而接口仍然返回 retcode 0（真实踩过）。
          return {
            type: 'music',
            data: {
              type: 'qq',
              id: s.songmid,
              title: s.title ?? '',
              singer: s.singer ?? '',
              url: s.url ?? '',
              image: s.image ?? '',
            },
          };
        }
        if (s.type === 'image') return { type: 'image', data: { file: s.file } };
        return { type: 'text', data: { text: s.text } };
      });
    const makeParams = (message) =>
      isGroup ? { group_id: Number(target.id), message } : { user_id: Number(target.id), message };

    try {
      const res = await this.call(action, makeParams(build(segments)));
      this.#rememberOwn(res?.message_id);
      this.#notifyOutgoing(target, segments, res?.message_id); // 归档：发成功了才记（带 id，别人引用它能查回原文）
      return true;
    } catch (err) {
      // 富消息这条链路最容易出问题（图片体积、格式、音乐卡片、平台限制）。失败就退回纯文本，
      // 绝不能因为一张表情包或一张卡片把整句话都丢了。
      const textOnly = segments.filter((s) => s.type === 'text');
      const hadRich = textOnly.length !== segments.length;
      this.#log('error', `发送失败：${err.message}${hadRich && textOnly.length ? '，退回纯文本重试' : ''}`);
      if (!hadRich || textOnly.length === 0) return false;
      try {
        await this.call(action, makeParams(build(textOnly)));
        return true;
      } catch (err2) {
        this.#log('error', `纯文本重发也失败：${err2.message}`);
        return false;
      }
    }
  }

  /**
   * **发文件**（2026-10-11 用户要的「漫画下载 → 压成 zip → 发给我」）。
   *
   * 走 OneBot 的 `upload_private_file` / `upload_group_file`；`file` 用 **`file://` 本地路径**
   * （HANDOFF 里记的就是这个写法：本地路径要用 `file://`，直接给绝对路径在 NapCat 那边不稳）。
   *
   * ⚠️ 这里**不抛错**，返回 `{ ok, detail }` —— 与 `trySendRich` 同一种风格，
   * 因为"文件没发出去"是调用方要负责降级的事（比如改发第一张图），
   * 不能让一个附件把整轮回复崩掉。
   */
  async uploadFile(target, { file, name } = {}) {
    const abs = String(file ?? '');
    if (!abs) return { ok: false, detail: '没有给文件路径' };
    const uri = /^file:\/\//i.test(abs) ? abs : `file:///${abs.replace(/\\/g, '/').replace(/^\/+/, '')}`;
    const isGroup = target.type === 'group';
    const action = isGroup ? 'upload_group_file' : 'upload_private_file';
    const params = isGroup
      ? { group_id: Number(target.id), file: uri, name: String(name ?? ''), folder: '' }
      : { user_id: Number(target.id), file: uri, name: String(name ?? '') };
    try {
      await this.call(action, params, 60000);
      this.#notifyOutgoing(target, [{ type: 'file', data: { name: String(name ?? '') } }]); // 归档：文件发出去了
      return { ok: true, detail: '' };
    } catch (err) {
      this.#log('warn', `发文件失败（${action}）：${err.message}`);
      return { ok: false, detail: err.message };
    }
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.timer);
    this.#failAllPending(new Error('客户端已关闭'));
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
  }
}
