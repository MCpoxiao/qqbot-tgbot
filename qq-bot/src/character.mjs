/**
 * 角色确认（2026-10-10 用户要求）：「**先上网搜角色，重复就询问，再去找图**」。
 *
 * 为什么要它：昵称（「洁哥」）直接拿去搜图经常搜不到，而重名（「胡桃」= 原神 / 蔚蓝档案）
 * 又会拿到不对的图。所以找图之前先做一步"这名字到底指谁"：
 *
 *   ① 先查**本地记过的**（`logs/character-map.json`）→ 命中就直接用；
 *   ② 没记过就**上网搜**（`web_search` + 一次 LLM 判断）→ 得出「正式名 + 出处」；
 *   ③ 出处**不止一个** → **停下来问用户**（把候选列出来），并把这问题挂起；
 *   ④ 用户回答了 → 记进本地表 → 再拿正式名去搜图。
 *
 * 全程**失败就放行**（网络/模型不给力时用原来的词去搜，别把找图卡死）。
 */

/** 从模型输出里抠出结论（容忍 ```json 围栏和前后废话）。返回 {clear,name,works,reason} 或 null。 */
export function parseResolveJson(text) {
  const raw = String(text ?? '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj = null;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const works = Array.isArray(obj.works) ? obj.works.map((x) => String(x).trim()).filter(Boolean) : [];
  return {
    clear: obj.clear === true,
    name: String(obj.name ?? '').trim(),
    works: [...new Set(works)].slice(0, 4),
    reason: String(obj.reason ?? '').trim().slice(0, 120),
  };
}

/** 判断这次要不要先上网确认（纯函数，可测）。 */
export function needResolve(query, { map = {}, known = {} } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return false;
  /**
   * 只在"这看着像一个**名字**"的时候才去联网确认（2026-10-10 自测把这条揪出来了）：
   * 光看长度不够 —— 「帮我找几张白丝萝莉的图」只有 11 个字，但它显然是描述句。
   * 所以：名字一般**很短**（≤ 8 字），且**不含**"图/照片/壁纸/几张/找/帮我"这类词。
   */
  if (q.length > 8) return false;
  if (/[图照壁头插画]|几张|帮我|找|搜|来点/.test(q)) return false;
  if (map[q]) return false; // 记过了
  if (known[q]) return false; // 配置里已经说清了（比如只有一个出处的）
  // 已经带作品名（「原神 胡桃」）就不用再确认
  for (const w of Object.values(known).flat?.() ?? []) if (w && q.includes(w)) return false;
  return true;
}

/** 让模型判断"这名字是谁"的提问（纯函数，可测）。 */
export function buildResolveAsk({ name, searchText }) {
  return [
    `在网上搜「${name}」这个（大概是二次元角色的）名字，下面是搜索结果。`,
    '请判断：这个名字**指的是哪个角色、出自哪个作品**？',
    '',
    '搜索结果：',
    String(searchText ?? '').slice(0, 1600),
    '',
    '只输出一个 JSON（不要别的话）：',
    '{"clear": true/false, "name": "角色的正式名字", "works": ["作品1","作品2"], "reason": "一句话依据"}',
    '规则：',
    '- 只有一个明确出处 → clear=true，works 只放那一个。',
    '- 有好几个常见出处（重名）→ clear=false，works 把主要的那几个都列上。',
    '- 完全没线索 → clear=false，works 留空。',
    '- 别猜：不确定就把 works 留空。',
  ].join('\n');
}

/** 用户回答里点了哪个候选作品（纯函数，可测）。 */
export function pickWorkFromAnswer(text, works) {
  const t = String(text ?? '');
  const list = Array.isArray(works) ? works : [];
  // ⚠️ 2026-10-10：这里原来有一句"整名命中就早退"（if (exact) return exact）—— 它会先撞上短的候选✗`n  //    （「明日方舟终末地」永远返回「明日方舟」）。删掉它，交给下面的打分逻辑。
  /**
   * ⚠️ 2026-10-10 实测：作品名常是「明日方舟：终末地」，而用户只答**后半截**「终末地」✗ ——
   * 所以除了整名与"冒号前那段"，还要把**按分隔符切开的每一段**都试一遍（长 ≥ 2）。
   */
  /**
   * ⚠️ 2026-10-10 实测：用户答「明日方舟终末地」，候选是 ['明日方舟','明日方舟：终末地'] ——
   * 上一版按顺序返回，先撞上短的「明日方舟」✗。改成**在全部候选里挑命中的最长那个**。
   */
  /**
   * 打分选**最具体**的那个候选：
   *  · 命中任意一段（≥2 字）→ 加该段长度；
   *  · **末段命中额外 +10** —— 用户答「明日方舟终末地」时，'明日方舟' 与 '明日方舟：终末地'
   *    都只匹配到「明日方舟」（并列 4），但后者的**末段「终末地」也命中** → 应该选它 ✓。
   */
  let best = '';
  let bestScore = 0;
  for (const w of list) {
    if (!w) continue;
    const segs = String(w).split(/[:：·、\/|\s]+/).map((x) => x.trim()).filter((x) => x.length >= 2);
    let score = 0;
    for (const s of segs) if (t.includes(s)) score += s.length;
    const last = segs[segs.length - 1];
    if (last && t.includes(last)) score += 10;
    if (score > bestScore) {
      bestScore = score;
      best = String(w);
    }
  }
  return best;
}

/** 搜图用的词：确认出来就带上出处的关键词（提高命中率）。 */
export function searchWordFor(resolved, fallback) {
  const name = resolved?.name || String(fallback ?? '').trim();
  const work = resolved?.works?.[0] ? String(resolved.works[0]).split(/[:：]/)[0].trim() : '';
  // ⚠️ 只用**名字**当搜索词：「原神 胡桃」这种双词在 pixiv 里会被当成两个标签，命中率反而低。
  //    出处只用来**过滤/说明**，不进搜索词。
  void work;
  return name;
}

/**
 * **「上一轮问了'是哪个作品'，他现在答了吗」** —— 抽成纯函数（2026-10-10）。
 *
 * 为什么要抽：这段逻辑在 `bot.mjs` 里**写了两份**（正则接管那条路 + 模型调工具那条路，
 * 即 HANDOFF 待办②说的技术债），两份各错一处、还都踩了用户报的那个 bug：
 *
 *  · 2026-10-10 用户报的第一个问题：**标签在"先问后答"里丢了** ✗
 *    他说「找找胡桃的 **r18** 图」→ 我们问「原神还是蔚蓝档案」→ 他答「原神」→
 *    接住回答那一步却**不带任何标签**去搜 → 拿回来的根本不是 R-18 图。
 *    → 所以 `pending.tags` 必须原样带回来（`tags` 字段），挂起和接住要成对。
 *  · 另一处：`imgQuery = searchWordFor(saved, refs.pendingCharacter?.name || imgQuery)`
 *    在把 `pendingCharacter` 置 null **之后**读它，等于永远退回原词，**正式名白解析了**。
 *
 * @param {{name?:string, canonical?:string, works?:string[], tags?:string[]}} pending 挂起的那条状态
 * @param {string} text 用户这一句
 * @returns {{chose:string, key:string, saved:{name:string,works:string[]}, query:string, tags:string[]}|null}
 *          认不出是哪个作品时返回 `null`（调用方负责再问一次）。
 */
export function interpretPendingAnswer(pending, text) {
  const chose = pickWorkFromAnswer(text, pending?.works ?? []);
  if (!chose) return null;
  const key = String(pending?.name ?? ''); // 角色表的键 = **昵称**（「洁哥」），以后再说它就能直接命中
  const canonical = String(pending?.canonical || pending?.name || '').trim(); // 搜索词 = **正式名**
  const saved = { name: canonical, works: [chose] };
  return {
    chose,
    key,
    saved,
    query: searchWordFor(saved, canonical) || canonical,
    tags: (Array.isArray(pending?.tags) ? pending.tags : []).slice(),
  };
}



