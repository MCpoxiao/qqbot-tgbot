/**
 * 人格相关的**文本级**改写。
 *
 * 为什么这些要写进代码而不是提示词：标点、频率这类东西是**可靠性问题**，
 * 模型做不可靠——实测同一句提示词，它有时全加上、有时一个都不加。
 * 凡是「只要是 X 就必须变成 Y」的规则，都应该由代码保证。
 * 模型负责"说什么"，代码负责"怎么落成字"。
 */

/** 已经带波浪号的判定：半角与全角都算。 */
const HAS_TILDE = /[~～]$/;

/** 回复里出现这些词，说明这一轮实际上也在嘴硬（可能没按排期来）。 */
const BRAT_WORDS = /杂鱼|笨蛋|哈？|就这|弱诶|你也太/;

export function looksBratty(text) {
  return BRAT_WORDS.test(String(text ?? ''));
}

/**
 * 嘴硬的时候，把**整条回复的最后一句**句末改成 `~`（「杂鱼主人真是的~」那种尾音）。
 *
 * 触发条件不是"文本里有杂鱼"，而是**这一轮是不是在嘴硬**——
 * 而这件事程序本来就知道（排期由代码定），所以不必去猜文本。
 * `bratty` 由调用方传入：排期放行的那一轮，或回复里确实出现了嘴硬词。
 *
 * 细节：
 *   - 只动**最后一句非空的那一行**，不逐句加，避免满屏都是 ~；
 *   - 句末本来是 `。！？，` 就替换成 `~`；本来没标点就追加；
 *   - 已经有 `~` / `～` 就不动，避免 `~~`；
 *   - 不动换行、不碰行尾空白。
 */
export function bratTilde(text, { bratty = false } = {}) {
  const s = String(text ?? '');
  if (!s || !bratty) return s;

  const lines = s.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const core = line.replace(/\s+$/, '');
    if (!core) continue; // 跳过空行，找最后一个有内容的
    if (HAS_TILDE.test(core)) return s; // 已经有了，不动
    const tail = line.slice(core.length);
    lines[i] = /[。！？!?，,、]$/.test(core) ? `${core.slice(0, -1)}~${tail}` : `${core}~${tail}`;
    return lines.join('\n');
  }
  return s;
}

/**
 * 把上面这层套到「段数组」上：**只改最后一个文本段**（也就是整条回复的结尾），
 * 图片段和其它文本段原样保留。
 */
export function bratTildeSegments(segments, { bratty = false } = {}) {
  if (!bratty) return segments;
  let last = -1;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].type === 'text') {
      last = i;
      break;
    }
  }
  if (last < 0) return segments;
  return segments.map((seg, i) => (i === last ? { ...seg, text: bratTilde(seg.text, { bratty: true }) } : seg));
}

/* ---------------- 像人一样"一条条发" ---------------- */

/** 给日志用：把一条消息的段落构成描述成 `文+卡片+图` 这种短串。 */
export function describeSegments(segments) {
  const name = { text: '文', image: '图', music: '卡片', voice: '语音', webimage: '网图' };
  return (segments ?? []).map((s) => name[s.type] ?? s.type).join('+') || '空';
}

/**
 * 保证"带卡片的段"里一定有文字。
 *
 * **实测（不是文档里写的）**：只有音乐卡片、没有文字的私聊消息会被 NapCat 拒绝——
 * `retcode 1200 消息体无法解析, 请检查是否发送了不支持的消息类型`；
 * 而"文字 + 卡片"就正常。所以卡片单独成段时必须补一个短文字，否则**整条卡片会丢掉**。
 *
 * 这不是理论问题：拆段逻辑完全可能把 `[[歌:…]]` 单独拆成一条
 * （模型把标记写在换行后面时就会这样）。
 */
export function ensureTextWithMusic(bubbles) {
  return bubbles.map((b) => {
    if (!b.some((s) => s.type === 'music')) return b;
    if (b.some((s) => s.type === 'text' && String(s.text ?? '').trim())) return b;
    // 兜底文字优先用歌名——比一个光秃秃的 🎵 连贯得多。
    // （真实踩过：模型只输出 [[歌:…]] 不带文字，用户先收到一个孤零零的 🎵。）
    const m = b.find((s) => s.type === 'music');
    const label = m?.title ? `🎵 ${m.title}${m.singer ? ` - ${m.singer}` : ''}` : '🎵';
    return [{ type: 'text', text: label }, ...b];
  });
}

const bubbleChars = (bubble) =>
  bubble.filter((s) => s.type === 'text').reduce((n, s) => n + s.text.length, 0);

/**
 * 把一条回复拆成「几条短消息」，像人一样一条条发出去。
 *
 * 规则刻意保持简单：
 *   - 空行是天然的段落边界，单个换行也算（模型经常用它代替空行）；
 *   - **不按长度合并短句**——人发消息就是短句连发，合并反而把"像人"抹掉了
 *     （这里踩过一次：加了"短于 N 字并进上一条"，结果几条短句连锁合并，永远只剩一条）；
 *   - **拆不了的就保持长的**：一整段没有换行的长文字（说明、清单、攻略步骤）
 *     原样发一条，绝不按字数硬切——硬切会把完整的意思切断，比长更糟；
 *   - 上限 `maxBubbles` 条，多出来的并进最后一条（防刷屏，也防 QQ 风控）。
 *
 * @param {Array<object>} segments splitReply/buildRichSegments 的产物
 * @returns {Array<Array<object>>} 每条消息一个 segment 数组
 */
export function splitIntoBubbles(segments, { maxBubbles = 4 } = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const cap = Math.max(1, Number(maxBubbles) || 1);
  if (cap === 1) return list.length ? [list] : [];

  const bubbles = [];
  let cur = [];
  const flush = () => {
    if (cur.length) bubbles.push(cur);
    cur = [];
  };

  for (const seg of list) {
    if (seg.type !== 'text') {
      // 图片跟着上一条文字走；要是开头就是图片，它自己开一条
      if (cur.length === 0 && bubbles.length) bubbles[bubbles.length - 1].push(seg);
      else cur.push(seg);
      continue;
    }
    for (const piece of String(seg.text).split(/\n+/)) {
      const text = piece.trim();
      if (!text) continue;
      cur.push({ ...seg, text });
      flush();
    }
  }
  flush();

  // 超上限就并进最后一条，宁可变长也不要刷屏
  while (bubbles.length > cap) {
    const tail = bubbles.pop();
    bubbles[bubbles.length - 1].push(...tail);
  }

  return bubbles;
}

/**
 * 两条消息之间该停多久（毫秒）。
 *
 * 按字数加长，像人在打字；也留了上下限——**下限是"别像连珠炮"，上限是"别让人干等"**。
 * 三个参数都可配（面板上能改），因为"多慢算自然"很主观，实测调过一次：
 * 一开始 base=650 / perChar=18，用户反馈"有点快了"。
 *
 * @param {Array<object>} bubble 一条消息的 segment 数组
 * @param {object} [opts] base=基础停顿, perChar=每个字加多少, max=上限, min=下限
 */
export function bubbleDelayMs(bubble, { base = 1200, perChar = 45, max = 4500, min = 1000 } = {}) {
  const chars = bubbleChars(bubble);
  return Math.min(max, Math.max(min, Math.round(base + chars * perChar)));
}
