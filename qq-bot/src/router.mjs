/**
 * 触发规则层——决定"这条消息要不要回、回的时候看什么文本"。
 * 这一层完全不认识 NapCat / 大模型，纯函数式的判定 + 一个冷却表。
 */

const PLACEHOLDER = {
  image: '[图片]',
  face: '[表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  json: '[卡片]',
  xml: '[卡片]',
  forward: '[合并转发]',
  reply: '',
  at: '',
};

/** 把 CQ 码字符串里的非文本段换成占位符，并把 @自己 去掉。 */
export function stripCq(text, selfId) {
  return text
    .replace(/\[CQ:at,qq=(\d+|all)[^\]]*\]/g, (_m, qq) =>
      String(qq) === String(selfId) || qq === 'all' ? '' : `@${qq} `,
    )
    .replace(/\[CQ:(image|face|record|video|file|json|xml|forward)[^\]]*\]/g, (_m, t) => PLACEHOLDER[t] ?? '')
    .replace(/\[CQ:reply[^\]]*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** 消息既可能是 array 段格式，也可能是 CQ 码字符串，两种都要吃。 */
export function extractText(message, selfId) {
  if (typeof message === 'string') return stripCq(message, selfId);
  if (!Array.isArray(message)) return '';
  const parts = [];
  for (const seg of message) {
    const type = seg?.type;
    const text = seg?.data?.text;
    if (type === 'text') parts.push(text ?? '');
    else if (type === 'at') {
      const qq = String(seg?.data?.qq ?? '');
      if (qq !== String(selfId) && qq !== 'all') parts.push(`@${qq} `);
    } else if (PLACEHOLDER[type]) parts.push(PLACEHOLDER[type]);
  }
  return parts.join('').trim();
}

/**
 * 从消息里取出**图片段**。OneBot 的 image 段既可能是 array 格式，也可能是 CQ 码字符串，两种都要吃。
 *
 * 为什么单拎出来：以前图片在 `extractText` 里被压成字面的「[图片]」三个字，
 * 模型完全看不到画面；而且只发图不配字时 text 为空，整条消息会被直接忽略。
 */
/**
 * **把文本里的 `[图片]` 标记摘掉**（2026-10-12 加，为修合并窗口那个 bug）。
 *
 * 背景：合并窗口把「`extractText()` 出来的文本」和「真实图片段」一起塞进合成消息，
 * 而那段文本**已经含一个 `[图片]`** → 合成后再 `extractText` 会再渲染一次 →
 * 模型看到 `[图片][图片]`（用户报「我发图他为啥识别两张」，日志里也是
 * `收到：[图片][图片]（+1 张图）`：括号说 1 张、文本说 2 张）。
 * 图片由图片段负责，文本里就不该再有标记。抽成纯函数便于断言。
 */
export function stripImagePlaceholders(text) {
  return String(text ?? '').replace(/\[图片\]/g, '');
}
export function extractImages(message) {
  const out = [];
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type !== 'image') continue;
      const d = seg.data ?? {};
      out.push({ file: String(d.file ?? ''), url: String(d.url ?? '') });
    }
    return out;
  }
  if (typeof message === 'string') {
    const re = /\[CQ:image,([^\]]*)\]/g;
    let m;
    while ((m = re.exec(message)) !== null) {
      const kv = {};
      for (const part of m[1].split(',')) {
        const i = part.indexOf('=');
        if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
      }
      out.push({ file: kv.file ?? '', url: kv.url ?? '' });
    }
  }
  return out;
}

/**
 * 「这条消息是在跟机器人说话吗」。
 * 两种算：**@它**，或者**引用回复它自己的某条消息**。
 * 为什么必须有第二种：手机版 QQ 里 @ 和图片**不能同时发**，于是「@ 它 + 发张图让它看」
 * 根本发不出去 —— 用户只能改成「引用它的消息 + 发图」，那种消息里没有 at 段，
 * 旧逻辑直接当没被叫、图也不看（2026-10-07 用户报「我让他识图都没用」）。
 */
/**
 * 从 **QQ 分享卡片**里抠链接。
 * 卡片在 OneBot 里是 `json` / `xml` 段，文本段是空的 —— 所以「发个 B站视频卡片」
 * 在旧逻辑里等于什么都没发（判成空文本，debug 级日志，连痕迹都没有）。
 * 抠出来的链接会当成文本喂给模型，B站 的还会走已有的视频解析。
 */
export function extractCardLinks(message) {
  const out = [];
  const push = (u) => {
    const s = String(u ?? '').trim();
    if (/^https?:\/\//i.test(s) && !out.includes(s)) out.push(s);
  };
  const segs = Array.isArray(message) ? message : [];
  for (const seg of segs) {
    const type = seg?.type;
    const d = seg?.data ?? {};
    if (type === 'json') {
      let obj = null;
      try {
        obj = JSON.parse(String(d.data ?? '{}'));
      } catch {
        /* 有的端给的不是纯 JSON，退化成正则 */
      }
      if (obj && typeof obj === 'object') {
        push(obj.jumpUrl);
        push(obj.url);
        const meta = obj.meta ?? {};
        push(meta?.detail_1?.qqdocurl ?? meta?.news?.jumpUrl ?? meta?.music?.jumpUrl);
      } else {
        const m = String(d.data ?? '').match(/https?:\/\/[^'"\\\s]+/);
        if (m) push(m[0]);
      }
    } else if (type === 'xml') {
      const s = String(d.data ?? '');
      for (const m of s.matchAll(/<url>([^<]+)<\/url>/g)) push(m[1]);
      const j = s.match(/https?:\/\/[^'"<\s]+/);
      if (j) push(j[0]);
    }
  }
  return out;
}

/** 消息里有没有「引用」段（引用的是谁都算）。 */
function hasReplySeg(message) {
  if (Array.isArray(message)) return message.some((s) => s?.type === 'reply');
  if (typeof message === 'string') return /\[CQ:reply,id=/.test(message);
  return false;
}

/** 文本里是不是出现了 @（有些客户端把 @ 当纯文本发过来，不是 at 段）。 */
function hasAtText(message, selfId) {
  const raw = Array.isArray(message)
    ? message.filter((s) => s?.type === 'text').map((s) => String(s?.data?.text ?? '')).join(' ')
    : String(message ?? '');
  return raw.includes('@');
}

function mentionsSelf(message, selfId, isOwn = () => false) {
  if (Array.isArray(message)) {
    return message.some(
      (s) =>
        (s?.type === 'at' && String(s?.data?.qq) === String(selfId)) ||
        (s?.type === 'reply' && isOwn(s?.data?.id)),
    );
  }
  if (typeof message === 'string' && /\[CQ:reply,id=([^\]]+)\]/.test(message)) {
    const m = message.match(/\[CQ:reply,id=([^\]]+)\]/);
    if (m && isOwn(m[1])) return true;
  }
  if (typeof message === 'string') {
    return new RegExp(`\\[CQ:at,qq=${selfId}(\\D|$)`).test(message);
  }
  return false;
}

export function createRouter(cfg, { isOwnMessage } = {}) {
  const cooldown = new Map();
  const groupRate = new Map(); // 非主人在群里的发言时间戳
  const isOwn = typeof isOwnMessage === 'function' ? isOwnMessage : () => false;

  /**
   * @returns {{reply:false, reason:string} | {reply:true, target:{type,id}, key:string, text:string, scope:string}}
   */
  function decide(evt, selfId) {
    if (!evt || evt.post_type !== 'message') return { reply: false, reason: `非消息事件(${evt?.post_type})` };
    if (evt.sub_type === 'self' || String(evt.user_id) === String(selfId)) {
      return { reply: false, reason: '自己发的消息' };
    }

    const isGroup = evt.message_type === 'group';
    const scope = isGroup ? 'group' : 'private';

    // 通道开关
    const mode = isGroup ? cfg.trigger.group : cfg.trigger.private;
    if (mode === 'off') return { reply: false, reason: `${scope} 通道已关闭` };

    // 白名单：按场景各自生效，空列表表示该场景不限制
    {
      const id = String(isGroup ? evt.group_id : evt.user_id);
      const list = (isGroup ? cfg.whitelist.groups : cfg.whitelist.users).map(String);
      if (list.length > 0 && !list.includes(id)) {
        return { reply: false, reason: `不在白名单（${scope} ${id}）` };
      }
    }

    // 群聊触发方式
    if (isGroup) {
      if (mode === 'mention' && !mentionsSelf(evt.message, selfId, isOwn)) {
        /**
         * **给主人开一条窄路**：手机版 QQ 没法「@ + 图片」同时发 —— 常见的替代是
         * 「引用某条消息 + 发图」（引用的往往是**他自己的**图），有时 @ 还会以纯文本形式过来。
         * 旧规则只认 at 段或「引用机器人的话」，于是这类消息被当空气（用户报「我引用我自己的图片@他不识别」）。
         * 限定得很死：**只有主人**、**必须带图**、且（引用了东西 或 文本里有 @）。其他人仍走原规则。
         */
        const hasImg = extractImages(evt.message).length > 0;
        /**
         * **群里所有人都能这样找它看图**（2026-10-07 用户要求"群友也可以用它识图"）。
         * 仍要求「带图 +（引用了某条消息 或 文本里有 @）」：不会退化成"谁发图它都搭话"。
         * 想关掉：trigger.groupImageReply = false。
         */
        const picturePath =
          cfg.trigger?.groupImageReply !== false &&
          hasImg &&
          (hasReplySeg(evt.message) || hasAtText(evt.message, selfId));
        if (!picturePath) return { reply: false, reason: '群聊未 @ 它（或没带图）' };
      }
      if (mode === 'keyword') {
        const raw = typeof evt.message === 'string' ? evt.message : evt.raw_message ?? '';
        const hit = (cfg.trigger.keywords ?? []).some((k) => raw.includes(k));
        if (!hit) return { reply: false, reason: '群聊未命中关键词' };
      }
    }

    let text = extractText(evt.message, selfId) || String(evt.raw_message ?? '').trim();
    if (mode === 'keyword') {
      for (const k of cfg.trigger.keywords ?? []) text = text.split(k).join('');
      text = text.trim();
    }
    // 只发图不配字也要理 —— 以前这里直接 return，用户发张图就被当空气。
    const images = extractImages(evt.message);
    // 分享卡片（B站视频/音乐/网页）里的链接也算内容 —— 不然这类消息等于空气
    const cards = extractCardLinks(evt.message);
    if (cards.length) {
      for (const c of cards) if (!text.includes(c)) text = text ? `${text}\n${c}` : c;
    }
    if (!text && images.length === 0) return { reply: false, reason: '空文本（也没有图片）' };
    if (text.length > cfg.limits.maxInputChars) {
      text = text.slice(0, cfg.limits.maxInputChars);
    }

    const key = isGroup ? `group:${evt.group_id}` : `private:${evt.user_id}`;
    const now = Date.now();
    const last = cooldown.get(key) ?? 0;
    /**
     * ⚠️ **主人私聊不走冷却丢弃**：冷却的本意是防刷屏，但它的实现是**把消息直接扔掉** ——
     * 连发三条，中间那条永远不会被回答、也永远不进上下文（2026-10-07 用户报的"会乱"就是它）。
     * 私聊主人改成靠 bot.mjs 的**合并窗口**防刷屏：攒 1.2 秒合成一轮再回，一个字都不丢。
     * 群聊保持原样（一屋子人 + 需要防刷屏，而且群里不该替所有人攒）。
     */
    const isMasterUser = (cfg.master?.users ?? []).map(String).includes(String(evt.user_id));
    /**
     * **非主人在群里的频率闸**：默认 3 分钟内最多 3 次，超了直接不理。
     * 主人**无限制**（他自己说了算）。想调：`limits.groupRate = { max, windowMs }`。
     * 为什么要它：放开了"群友也能找它识图"，就得配一个闸，否则一个人能把它刷爆。
     */
    if (isGroup && !isMasterUser) {
      const lim = cfg.limits?.groupRate ?? {};
      const max = Number(lim.max ?? 3);
      const win = Number(lim.windowMs ?? 3 * 60 * 1000);
      const uid = String(evt.user_id);
      const hits = (groupRate.get(uid) ?? []).filter((ts) => now - ts < win);
      if (max > 0 && hits.length >= max) {
        groupRate.set(uid, hits);
        return { reply: false, reason: `群友 ${uid} 太频繁（${max} 次 / ${Math.round(win / 60000)} 分钟）` };
      }
      hits.push(now);
      groupRate.set(uid, hits);
    }
    // 主人**全场景**豁免冷却（他自己说了算；群里的频率闸也只管非主人）
    const masterPrivate = isMasterUser;
    if (!masterPrivate && now - last < cfg.limits.cooldownMs) {
      return { reply: false, reason: `冷却中（剩 ${cfg.limits.cooldownMs - (now - last)}ms）` };
    }
    cooldown.set(key, now);

    return {
      reply: true,
      reason: 'ok',
      scope,
      key,
      text,
      images,
      target: isGroup
        ? { type: 'group', id: String(evt.group_id) }
        : { type: 'private', id: String(evt.user_id) },
    };
  }

  return { decide, cooldown };
}
