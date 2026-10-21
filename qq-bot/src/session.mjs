import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 多轮上下文。按会话 key（私聊/群聊）分开存，带轮数上限和空闲过期。
 * 只存纯文本，不存工具调用、图片等结构，够聊天用。
 *
 * **落盘（`file` 选项）**：以前这里是个纯内存的 Map，于是**每次重启机器人就彻底失忆**——
 * 而机器人重启得很频繁（改代码、NapCat 挂了、关机），用户会明显感觉"它不记得我"。
 * 现在可选地把会话写到磁盘、启动时读回来。
 *
 * 两条硬约束：
 *  ① **落盘失败绝不影响聊天**——记忆坏了是小事，机器人起不来是大事，所以全 try 住。
 *  ② **写入用「临时文件 + rename」**：直接覆写有可能写到一半断电，把旧记忆也毁了。
 */
export class Sessions {
  constructor({ historyTurns = 6, ttlMs = 1800000, file = null, maxChars = 12000 } = {}) {
    this.historyTurns = historyTurns;
    this.ttlMs = ttlMs;
    this.maxChars = Number(maxChars) > 0 ? Number(maxChars) : 0;
    this.file = file || null;
    this.map = new Map();
    this.saveTimer = null;
    if (this.file) this.load();
  }

  #bucket(key) {
    const now = Date.now();
    let b = this.map.get(key);
    if (!b || now - b.touchedAt > this.ttlMs) {
      b = { messages: [], touchedAt: now };
      this.map.set(key, b);
    }
    b.touchedAt = now;
    return b;
  }

  /** 取历史消息（不含本轮输入）。 */
  history(key) {
    return this.#bucket(key).messages.slice();
  }

  /**
   * 记录一轮问答。空回复不记，避免污染上下文。
   * `speaker` 是说话人的显示名——**群聊里必须传**，见 toMessages 的说明。
   */
  record(key, userText, assistantText, speaker) {
    const b = this.#bucket(key);
    b.messages.push(speaker ? { role: 'user', content: userText, speaker } : { role: 'user', content: userText });
    if (assistantText) b.messages.push({ role: 'assistant', content: assistantText });
    this.#trim(b);
    this.#scheduleSave();
  }

  /** 记一次失败，只留用户那句话，让下一轮知道用户说过什么。 */
  recordUserOnly(key, userText, speaker) {
    this.record(key, userText, null, speaker);
  }

  #trim(b) {
    // 两道闸：
    //  ① 轮数上限（historyTurns 轮 -> 2 倍条数）；
    //  ② **总字符上限**——只按轮数限制是不够的：50 轮长消息能到十几万字，
    //     逼近模型上下文会直接报错。按字符数兜住，才是真的"能记多少"。
    //     至少保留最后一轮，否则一句超长输入就能把上下文清空。
    const max = this.historyTurns * 2;
    if (b.messages.length > max) b.messages.splice(0, b.messages.length - max);

    const budget = this.maxChars;
    if (budget > 0) {
      let total = b.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
      // 从头丢整轮（一进一出算一轮），别丢半轮——只留一句问话、没有回答会更乱
      while (total > budget && b.messages.length > 2) {
        const drop = b.messages.splice(0, 2);
        total -= drop.reduce((n, m) => n + (m.content?.length ?? 0), 0);
      }
    }
  }

  /**
   * 渲染成给模型的 messages。
   *
   * `label: true` 时给用户消息加「说话人：」前缀。**群聊必须开**：同一个群共用一份历史，
   * 不标是谁说的，模型就会把上一个人的话当成当前这个人说的——真实症状就是"认错人"：
   * 主人在群里说过话之后，另一个人来搭话，它照着上文继续叫主人。
   * 私聊只有一个人，不用加。
   */
  toMessages(key, { label = false } = {}) {
    return this.history(key).map((m) =>
      m.role === 'user' && label && m.speaker
        ? { role: 'user', content: `${m.speaker}：${m.content}` }
        : { role: m.role, content: m.content },
    );
  }

  /** 只追加一条助手消息（主动开口时用：我们自己开了口，得让它留在上下文里）。 */
  recordAssistant(key, assistantText) {
    if (!assistantText) return;
    const b = this.#bucket(key);
    b.messages.push({ role: 'assistant', content: assistantText });
    this.#trim(b);
    this.#scheduleSave();
  }

  /**
   * 只读快照：列出所有会话及最后活跃时间。
   * **故意不刷新 touchedAt**——否则"检查一下"这个动作本身就会把空闲计时清零，
   * 主动开口永远等不到时机。
   */
  snapshot() {
    const out = [];
    for (const [key, b] of this.map) {
      out.push({ key, lastAt: b.touchedAt, messages: b.messages.slice() });
    }
    return out;
  }

  reset(key) {
    this.map.delete(key);
    this.#scheduleSave();
  }

  /** 清掉过期会话，长跑时定期调。 */
  sweep() {
    const now = Date.now();
    let n = 0;
    for (const [k, b] of this.map) {
      if (now - b.touchedAt > this.ttlMs) {
        this.map.delete(k);
        n += 1;
      }
    }
    if (n) this.#scheduleSave();
    return n;
  }

  // ---------- 落盘 ----------

  /** 从磁盘读回。**过期的会话直接丢**，不然重启一次就把半小时前的话题又拖回来。 */
  load() {
    if (!this.file) return 0;
    try {
      if (!existsSync(this.file)) return 0;
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const now = Date.now();
      let n = 0;
      for (const b of raw?.buckets ?? []) {
        const key = b?.key;
        if (!key || !Array.isArray(b.messages) || b.messages.length === 0) continue;
        const touchedAt = Number(b.touchedAt) || now;
        if (now - touchedAt > this.ttlMs) continue;
        const messages = b.messages
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-this.historyTurns * 2);
        if (!messages.length) continue;
        const bucket = { messages, touchedAt };
        this.map.set(String(key), bucket);
        this.#trim(bucket);
        n += 1;
      }
      return n;
    } catch {
      return 0; // 文件坏了就当没有记忆——绝不能因此起不来
    }
  }

  /**
   * 防抖保存：聊天可能连着来好几条，没必要每条都写盘。
   * 2 秒一次足够，而且崩溃时最多丢最后 2 秒。
   */
  #scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 2000);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  /** 立即写盘（退出前、测试里用它）。原子替换：临时文件 + rename。 */
  flush() {
    if (!this.file) return false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const data = {
        v: 1,
        savedAt: Date.now(),
        buckets: this.snapshot().map((b) => ({ key: b.key, touchedAt: b.lastAt, messages: b.messages })),
      };
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, this.file);
      return true;
    } catch {
      return false; // 落盘失败不该影响聊天
    }
  }

  get size() {
    return this.map.size;
  }
}
