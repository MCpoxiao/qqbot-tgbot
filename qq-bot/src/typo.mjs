/**
 * **错别字容错**（2026-10-14 用户提出：「我有时候会有错别字」）。
 *
 * ## 为什么需要它
 * 项目里有两类**硬匹配**的地方，打错一个字就完全失效 ✗：
 * - `src/commands.mjs` 的 `parseCommand`：**首尾锚定**的正则（`^群列表$` ✓）⇒「群列标」直接不认 ✓；
 * - `bot.mjs` 的 `wantsZipPack`：「打包/整本/所有页…」✓ ⇒「打饱」不认 ✓。
 * 而**聊天内容**不用管 ✓（模型自己看得懂错别字 ✓）—— 要救的只是这些"代码里写死的开关" ✓。
 *
 * ## 两条硬规矩（都很重要）
 * 1. **只对"安全"的词做模糊** ✓：只读命令（群列表/状态/进程/窗口）和打包这类**无害**动作 ✓。
 *    **退群绝不模糊匹配** ✗✗ —— 它是不可逆的 ✓，把「推群」容错成「退群」是灾难 ✓。
 *    这一点由**调用方**保证（`commands.mjs` 里退群那条仍然走精确正则 ✓）。
 * 2. **每次容错命中都留痕** ✓：日志写清「把 A 当成 B」✓ ——
 *    这样**真实的错别字会自己浮出来** ✓（比凭空猜一张错字表可靠 ✓，也是这个项目一贯的做法 ✓）。
 *
 * ## 判据
 * - 先**归一化** ✓（全角转半角、去掉空格和标点、统一小写 ✓）—— 「群 列 表！」和「群列表」等价 ✓；
 * - 再用**有上界的编辑距离** ✓（默认 ≤1 ✓，短词更严 ✓）：
 *   长度 1 的词**不允许**模糊 ✗（一个字错一点就变成另一个字 ✓）；
 *   长度 2 的词允许 1 处差异 ✓（代价是可能误判，比如「打包」≈「打败」✓ —— 所以**必须记日志** ✓）；
 *   长度 ≥3 的词允许 1 处差异 ✓（很安全 ✓）。
 */

/** 全角 → 半角（数字/字母/常见标点在容错场景里最常见）。 */
function toHalfWidth(s) {
  return String(s ?? '').replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
}

/**
 * 归一化：全角转半角 → 去掉空白与常见标点 → 小写。
 * ⚠️ **不做同音字替换** ✗：那需要拼音表 ✓，凭空猜错字表不如让日志说话 ✓。
 */
export function normalizeForMatch(text) {
  return toHalfWidth(text)
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）《》【】,.!?;:"'()<>[\]{}~·\-—_/\\|]+/g, '')
    .toLowerCase();
}

/**
 * **有上界的编辑距离**：只关心"是否 ≤ max"，超出就提前返回 ✓（比标准算法省事 ✓）。
 * 支持替换/插入/删除 ✓（错别字最常是"打错一个字母/字"✓）。
 */
export function editDistanceWithin(a, b, max = 1) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s === t) return 0;
  if (Math.abs(s.length - t.length) > max) return max + 1;
  // 经典 DP，但只保留两行 + 超过 max 直接剪枝（词都很短，够用 ✓）
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // 这一行已经不可能回到 max 以内 ✓
    prev = cur;
  }
  return prev[t.length];
}

/**
 * **整串**是否（模糊地）等于某个关键词 —— 给 `parseCommand` 那种"首尾锚定"的场景用 ✓。
 * @returns {{keyword:string, dist:number}|null}
 */
export function matchWholeKeyword(text, keywords, { maxDist = 1, log = null } = {}) {
  const s = normalizeForMatch(text);
  if (!s) return null;
  for (const kw of keywords) {
    const k = normalizeForMatch(kw);
    if (!k) continue;
    if (s === k) return { keyword: kw, dist: 0 }; // 精确命中（正常路径 ✓）
    if (k.length < 2) continue; // ⚠️ 单字词不模糊 ✗
    const d = editDistanceWithin(s, k, maxDist);
    if (d <= maxDist) {
      log?.(`[容错] 把「${String(text).trim()}」当成「${kw}」（差 ${d} 个字）`);
      return { keyword: kw, dist: d };
    }
  }
  return null;
}

/**
 * ⚠️ **这里原来还有一个 `findKeywordInText()`（滑窗式"文本里包含某关键词，允许错别字"）** ✗，
 * **2026-10-15 已删除** ✓ —— 它把用户的正常句子判成了"要打包"（细节见 `bot.mjs` 的 `wantsZipPack` ✓）：
 * ```
 * 「好啦，处理完所有的事了…」 → 命中「所有页」✗
 * 「我想打牌」              → 命中「打包」✗
 * 「压力好大」              → 命中「压缩」✗
 * ```
 * **教训**：中文短词里"差一个字"往往就是**另一个常用词** ✓ ⇒
 * **"包含即算"的场景不允许模糊匹配** ✗；容错只在**整句锚定**（上面的 `matchWholeKeyword` ✓）才安全 ✓。
 */

