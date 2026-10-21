/**
 * 「同一个梗刷太多遍」的检查。
 *
 * ## 为什么需要它（2026-10-09 用户报「他怎么一直卡日历上」）
 *
 * 用户以为那是搜索引擎的锅。查了日志：**不是**。那套「今日宜躺 / 忌踩自己」是
 * **它自己发明的段子格式**，一天用了三次；它给用户的解释（「它一打开就往我脸上糊黄历」）
 * 还是现编的。当天 5 条冲浪素材里没有任何黄历内容。
 *
 * 这是模型的**表达习惯重复**（同一个硬趣味反复用），搜索引擎、提示词缓存都无关。
 * 治法也只能是"看出来就提醒它换一个"——纯函数、可测、不靠模型自觉。
 *
 * 两条判据（都写成"宁可漏、不可误伤"）：
 *  1. **认得的固定段子格式**（目前只有黄历：宜…忌…）；
 *  2. **整句原样重复**：同一句 8 字以上、在她最近的话里出现 ≥2 次 —— 这是退化的硬信号。
 *     （不查"句式相似"，那会把「诶……」「噗」这类口头禅全误伤。）
 */
const GIMMICKS = [
  { name: '黄历（宜…忌…）', re: /(?:今日)?宜\s*[^。！？\n]{1,12}[，、,]\s*忌|忌\s*[^。！？\n]{1,12}[，、,]\s*宜|宜\s*[^。！？\n]{1,10}忌\s*[^。！？\n]{1,10}/ },
];

/** 把一段话切成句子（用于"整句原样重复"的比对）。 */
function sentences(text) {
  return String(text ?? '')
    .split(/[\n。！？!?；;]+/)
    .map((s) => s.replace(/[「」“”"'（）()\s]/g, '').trim())
    .filter((s) => s.length >= 8);
}

/**
 * @param {string[]} texts 她自己最近说过的几段话（时间正序）
 * @param {{min?:number}} [opts] `min` = 触发阈值（默认 2）
 * @returns {Array<{name:string, count:number, sample:string}>}
 */
export function repeatedGimmicks(texts, { min = 2 } = {}) {
  const list = (texts ?? []).map((t) => String(t ?? '')).filter(Boolean);
  if (list.length < min) return [];
  const out = [];

  for (const g of GIMMICKS) {
    const hits = list.filter((t) => g.re.test(t));
    if (hits.length >= min) {
      out.push({ name: g.name, count: hits.length, sample: (hits[hits.length - 1].match(g.re) ?? [''])[0].slice(0, 24) });
    }
  }

  // 整句原样重复（同一句 ≥8 字，出现 ≥2 次）
  const seen = new Map();
  for (const t of list) {
    for (const s of new Set(sentences(t))) {
      const rec = seen.get(s) ?? { count: 0, sample: s };
      rec.count += 1;
      seen.set(s, rec);
    }
  }
  for (const [, rec] of seen) {
    if (rec.count >= min) out.push({ name: '同一句原样重复', count: rec.count, sample: rec.sample.slice(0, 24) });
  }
  return out;
}

/**
 * 给她的一段提醒（拼进系统提示词）。没有重复时给空串。
 * 语气是"提醒"而不是"训话"—— 她要的是换个说法，不是被否决。
 */
export function repeatNote(texts, { min = 2 } = {}) {
  const bad = repeatedGimmicks(texts, { min });
  if (!bad.length) return '';
  const lines = bad.map((b) => `· 「${b.name}」你最近用了 ${b.count} 次${b.sample ? `（例如「${b.sample}」）` : ''}`);
  return (
    '【别重复这个】' +
    lines.join('；') +
    '。这一轮**换个说法**，或者干脆不提这件事 —— 同一个梗连着用会显得像复读机（主人已经嫌过一次了）。'
  );
}
