/**
 * 以图搜图 —— 动漫截图溯源。
 *
 * 用 **trace.moe**：免费、无需 API key、专门做动画截图检索，
 * 能回答「这张截图出自哪部动画、第几集、第几秒」，这正是「帮我认一下这是谁」最需要的信息。
 *
 * ⚠️ 三个必须记住的性质：
 *   1. 它是**动漫专用**。照片、表情包、真人、游戏 CG 会返回空结果 —— 那是**正常**的，不是失败。
 *   2. 搜索词是**图片本身**，所以不依赖图片 URL 能被外网访问（直接 POST 二进制）。
 *   3. 有速率限制，所以必须给超时、且失败时返回 null 而不是抛错。
 */

const ENDPOINT = 'https://api.trace.moe/search';
const UA = 'qq-bot/0.1 (local)';

/**
 * 相似度低于这个值就不当作命中，免得给出一个错得离谱的动画名。
 *
 * ⚠️ **2026-10-14 从 0.82 抬到 0.90**：用户报「能不能把动漫角色识图成功率拉高些」，
 * 我拿他真机发的那张图（少女前线的 3D 渲染）实测：
 * | 源 | 结果 |
 * | --- | --- |
 * | trace.moe | **82.8% 判成《Zombie-Loan》第 9 集** ✗（完全是错的） |
 * | SauceNAO | 36.55% 判成「Yuudachi」 ✗ |
 * ⇒ 0.82 这个门槛**太低**：对"游戏 CG / 3D 渲染 / 同人图"这类**非动画截图**，
 * trace.moe 会在 0.7~0.85 区间给出**看起来很确定的错答案** ✓。
 * 宁可空手而归（老老实实说"认不出"），也不要一个像样的错答案 ✓ ——
 * 这是这个项目一贯的口径（见 `vision.mjs` 顶上那段历史）。
 */
const DEFAULT_MIN_SIMILARITY = 0.9;

/**
 * 小于这个字节数就**不送溯源**。
 *
 * 实测教训：一张 264 字节的图被 trace.moe 判成某动画第 11 集「相似度 100.0%」——
 * 画面特征太少时它会给荒谬的高分。所以必须在送出去之前挡掉，
 * 否则用户发个纯色图/小图标，机器人会一口咬定「这是《Sacred Seven》第 11 集」。
 */
const MIN_TRACE_BYTES = 4 * 1024;

function fmtSeconds(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function pickTitle(anilist) {
  const t = anilist?.title ?? {};
  return t.chinese || t.native || t.romaji || t.english || '';
}

/**
 * @param {Buffer} buffer 图片二进制
 * @param {{timeoutMs?:number, minSimilarity?:number, allowAdult?:boolean}} opts
 * @returns {Promise<null | {similarity:number,title:string,titleNative:string,episode:number|null,
 *   at:string,format:string,year:number|null,isAdult:boolean,anilistId:number|null}>}
 *   没命中、超时、接口挂了 —— 一律 null（调用方只需判断真假）。
 */
export async function traceAnime(buffer, { timeoutMs = 12000, minSimilarity = DEFAULT_MIN_SIMILARITY, allowAdult = false } = {}) {
  if (!buffer || !buffer.length) return null;
  if (buffer.length < MIN_TRACE_BYTES) return null; // 太小的图必然误报，见常量上的说明

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINT}?anilistInfo`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'user-agent': UA },
      body: buffer,
      signal: ctrl.signal,
    });
    if (!res.ok) return null;

    const j = await res.json();
    if (j?.error) return null;

    const list = Array.isArray(j?.result) ? j.result : [];
    if (!list.length) return null;

    // 从命中里挑第一条：既够像、又不是成人内容（除非明确允许）。
    const hit = list.find(
      (r) => Number(r?.similarity ?? 0) >= minSimilarity && (allowAdult || !r?.anilist?.isAdult),
    );
    if (!hit) return null;

    const a = hit.anilist ?? {};
    return {
      similarity: Number(hit.similarity ?? 0),
      title: pickTitle(a),
      titleNative: a?.title?.native ?? '',
      episode: hit.episode ?? null,
      at: fmtSeconds(hit.from),
      format: a?.format ?? '',
      year: a?.startDate?.year ?? null,
      isAdult: Boolean(a?.isAdult),
      anilistId: a?.id ?? null,
    };
  } catch {
    // 超时 / 网络抖动 / 接口改了 —— 都不该影响这一轮回复
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 把结果转成给模型看的一行中文。 */
export function formatTraceHit(hit) {
  if (!hit) return '';
  const eps = hit.episode ? `第 ${hit.episode} 集` : '（集数未知）';
  const year = hit.year ? `${hit.year} 年` : '';
  const native = hit.titleNative && hit.titleNative !== hit.title ? `（原名 ${hit.titleNative}）` : '';
  return (
    `疑似出自《${hit.title}》${native} ${eps} ${hit.at} 附近` +
    `${year ? `，${year}` : ''}，相似度 ${(hit.similarity * 100).toFixed(1)}%`
  );
}

// ───────────────────────── SauceNAO（同人图 / 立绘 / pixiv）─────────────────────────

/**
 * **SauceNAO**：二次元**插画/同人图/立绘**溯源的事实标准 ✓（trace.moe 只认动画截图 ✗）。
 *
 * ⚠️ 为什么不走它的 JSON API ✗：那个要 `api_key` ✓（免费但要注册 ✓）。
 * 这里用**网页版表单** ✓（POST 一个文件 ✓，返回 HTML ✓）—— 免 key ✓、实测可用 ✓。
 * 代价：结果是 HTML ✗，得抠字段 ✓ ⇒ 解析器要写得**防守型**（抠不到就当没命中 ✓，
 * 绝不因为页面改版就抛错影响聊天 ✓）。
 *
 * ⚠️ **超时必须短**（2026-10-14 实测改）：这一路是在**回复路径里同步等的** ✓ ——
 * 第一版给了 45 秒，实测归档里好几张图真的拖满 45 秒 ✗✗（她那一轮回复就卡 45 秒 ✓）。
 * 现在默认 **12 秒** ✓（和 trace.moe 一个量级 ✓）；宁可少认一张，也不能让回复卡住 ✓。
 *
 * 限流：匿名大约 4 次 / 30 秒 ✓ —— 调用方要有冷却（识图本身有"同一张图只读一次"的缓存 ✓）。
 *
 * @returns {Promise<null | {similarity:number,title:string,author:string,url:string,index:string}>}
 */
export async function sauceNaoSearch(buffer, { timeoutMs = 12000, minSimilarity = 0.6 } = {}) {
  if (!buffer || !buffer.length) return null;
  if (buffer.length < MIN_TRACE_BYTES) return null; // 小图必误报，和 trace.moe 同一条规矩 ✓
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer]), 'a.jpg');
    form.append('db', '999'); // 999 = 全部索引（pixiv / twitter / anime / …）
    form.append('numres', '6');
    const res = await fetch('https://saucenao.com/search.php', {
      method: 'POST',
      headers: { 'user-agent': 'Mozilla/5.0' },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseSauceNaoHtml(html, { minSimilarity });
  } catch {
    return null; // 超时/限流/改版 —— 都不该影响这一轮回复 ✓
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 SauceNAO 的 HTML 里抠出最像的那一条（**纯函数，自测直接喂样例 HTML** ✓）。
 *
 * 页面结构（2026-10-14 实测）：每个结果一个 `class="result"` 块，里面有
 * `…% similarity`、标题链接、以及来源站点名 ✓。这里**只看这几样** ✓，
 * 而且**任何一步抠不到就跳过这条** ✓（宁可少认，不可乱认 ✓）。
 */
export function parseSauceNaoHtml(html, { minSimilarity = 0.6 } = {}) {
  const text = String(html ?? '');
  if (!text || /Too many requests|rate limit/i.test(text)) return null;
  const blocks = text.split(/<div class="result"|<div class ="result"/).slice(1);
  let best = null;
  for (const b of blocks) {
    const sim = Number((b.match(/([0-9]{1,3}(?:\.[0-9]+)?)%\s*similarity/i)?.[1] ?? b.match(/similarity[^0-9]{0,12}([0-9]{1,3}(?:\.[0-9]+)?)/i)?.[1] ?? '') || 0);
    if (!sim) continue;
    const titleRaw =
      b.match(/<a[^>]*class="title"[^>]*>([\s\S]{0,120}?)<\/a>/i)?.[1] ??
      b.match(/<strong>([\s\S]{0,120}?)<\/strong>/i)?.[1] ??
      '';
    let title = titleRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    /**
     * ⚠️ **把"字段标签"当标题要丢掉**（2026-10-14 实测）：回退用的 `<strong>` 会抠到
     * `Creator:` / `Member:` / `Author:` 这种标签 ✓ —— 归档里那张 97.3% 的命中就显示成
     * 「最像的是「Creator:」」✗（难看得毫无信息量 ✓）。标签一律丢掉 ✓，
     * 标题空着没关系（还有作者和链接 ✓）。
     */
    if (/^(creator|member|author|artist|title)\s*:?$/i.test(title)) title = '';
    const url = b.match(/href="(https?:\/\/[^"]+)"/i)?.[1] ?? '';
    const author =
      (b.match(/(?:Member|Creator|Author)\s*:?\s*<[^>]*>([^<]{0,60})/i)?.[1] ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    // 来源站点名（pixiv / Twitter / ……）—— 标题里常带，单独再抠一次更稳 ✓
    const index = (b.match(/class="subtext"[^>]*>([\s\S]{0,60}?)</i)?.[1] ?? '').replace(/<[^>]+>/g, ' ').trim();
    const ratio = sim / 100;
    if (ratio < minSimilarity) continue;
    if (!best || ratio > best.similarity) best = { similarity: ratio, title, author, url, index };
  }
  return best;
}

/** 把 SauceNAO 的结果转成一行中文（给模型看 ✓）。 */
export function formatSauceHit(hit) {
  if (!hit) return '';
  const who = hit.author ? ` 作者 ${hit.author}` : '';
  const where = hit.url ? `　${hit.url}` : '';
  return `以图搜图（插画库）最像的是「${hit.title || '（无标题）'}」${who}，相似度 ${(hit.similarity * 100).toFixed(1)}%${where}`;
}

/**
 * **把两个源的结果合成一个判断**（纯函数 ✓ —— 抽出来就是为了能离线自测 ✓）。
 *
 * 规则（都是 2026-10-14 用真机图定的）：
 * - 最高相似度 ≥ 0.9 → `high`（可以说"应该是"）；
 * - 0.6 ~ 0.9 → `medium`（只能说"可能是"）；
 * - 更低 → `low`（**不许当结论说** ✗）；
 * - **两个源都命中但作品对不上** → 强制降成 `low` ✓（冲突本身就是"没把握" ✓）。
 * @returns {null | {anime:object|null, sauce:object|null, confidence:'high'|'medium'|'low', top:number, text:string}}
 */
export function combineVerdict(anime, sauce) {
  const parts = [];
  if (anime) parts.push(formatTraceHit(anime));
  if (sauce) parts.push(formatSauceHit(sauce));
  if (!parts.length) return null;

  let confidence = 'low';
  const top = Math.max(anime?.similarity ?? 0, sauce?.similarity ?? 0);
  if (top >= 0.9) confidence = 'high';
  else if (top >= 0.6) confidence = 'medium';

  if (anime && sauce && confidence !== 'low') {
    const a = String(anime.title ?? '');
    const s = String(sauce.title ?? '');
    const native = String(anime.titleNative ?? '');
    const sameish = Boolean(a && s && (a.includes(s) || s.includes(a) || (native && s.includes(native))));
    if (!sameish) confidence = 'low';
  }
  return { anime: anime ?? null, sauce: sauce ?? null, confidence, top, text: parts.join('\n') };
}

/**
 * **把几个源合起来给一个判断**（2026-10-14 加，用户要"提高成功率"）。
 *
 * 为什么要合：单看任何一个源都会给出**像样的错答案** ✓（实测那张图：
 * trace.moe 82.8% 说 Zombie-Loan ✗、SauceNAO 36% 说 Yuudachi ✗）。
 * 合成的规则见 `combineVerdict`（纯函数，自测直接钉 ✓）。
 *
 * ⚠️ **总超时必须压住**（2026-10-14 实测踩到 ✗）：这一路是在**回复路径里同步等的** ✓，
 * 第一版给了 45 秒 ⇒ 归档里真有图拖满 45 秒 ✗✗（她那一轮回复卡死在识图上 ✓）。
 * 现在**整个认图 ≤ 15 秒** ✓（两个源并行 ✓，各自再短一点 ✓）——
 * 认不出就认不出，**绝不能把回复卡住** ✓。
 */
export async function identifyImage(buffer, { timeoutMs = 15000, minAnimeSimilarity = DEFAULT_MIN_SIMILARITY, minSauceSimilarity = 0.6 } = {}) {
  const [anime, sauce] = await Promise.all([
    traceAnime(buffer, { timeoutMs: Math.min(timeoutMs, 12000), minSimilarity: minAnimeSimilarity }).catch(() => null),
    sauceNaoSearch(buffer, { timeoutMs, minSimilarity: minSauceSimilarity }).catch(() => null),
  ]);
  return combineVerdict(anime, sauce);
}
