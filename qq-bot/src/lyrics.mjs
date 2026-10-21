/**
 * **歌词 / 接歌 / 听歌词识曲**（2026-10-11 用户要「能不能让他能读歌词跟我接歌啊」，
 * 随后追加「一定要网易云吗，qq（我有 vip），酷狗不行吗」）。
 *
 * ## 为什么要多个源，以及为什么 QQ 音乐当主源
 * 实测（2026-10-11，同一批歌）：
 *
 * | | QQ 音乐 | 网易云 |
 * | --- | --- | --- |
 * | 周杰伦《稻香》 | **原唱** ✓ | 只有翻唱（`稻香(深情版)`），**歌词 0 句** ✗ |
 * | 「天青色等烟雨」识曲 | **青花瓷 - 周杰伦** ✓ | 青花瓷 - 刘芳（翻唱）⚠️ |
 * | 歌词检索 | ✓（`client_search_cp` 天然支持按歌词搜） | ✓（要 `type=1006`） |
 * | 歌词格式 | `nobase64=1` 直接**明文 LRC** | 明文 LRC |
 *
 * 用户有 QQ 音乐 VIP，且中文流行歌库 QQ 更全 → **主源 = `qq`，网易云 = 兜底**。
 * 酷狗的接口这次直接 `fetch failed`，暂不接。
 *
 * ## 设计原则（跟项目里其它"查事实"的模块一致）
 * - **绝不退回"模型自己背歌词"**：日志里唯一一条歌词记录就是她凭记忆背的
 *   （`听过呀，就是那首《Paris》嘛，歌词是「If we go…」`）—— 会记串、漏段、编词。
 * - 拿不到就**如实说拿不到**（版权受限、纯音乐、接口挂了都算"拿不到"）。
 * - 识曲**必须核对**：猜的歌名要在歌词里**真的找到那句**才算认出来。
 */

const HEADERS = {
  qq: { 'user-agent': 'Mozilla/5.0', referer: 'https://y.qq.com/' },
  netease: { 'user-agent': 'Mozilla/5.0', referer: 'https://music.163.com/' },
};

/** 默认源顺序：先 QQ（歌库全 + 用户有 VIP），再网易云（兜底）。 */
export const SOURCES = ['qq', 'netease'];

/** LRC 行：`[00:25.237]这一路上走走停停` */
const LRC_RE = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/;

/**
 * 解析 LRC（纯函数，可单测）。
 * @returns {Array<{t:number|null, text:string}>} `t` 是毫秒（无时间戳给 null）
 */
export function parseLrc(raw) {
  const out = [];
  for (const line of String(raw ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const m = s.match(LRC_RE);
    if (m) {
      const ms = Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(String(m[3] ?? '0').padEnd(3, '0').slice(0, 3));
      const text = m[4].trim();
      if (text) out.push({ t: ms, text });
      continue;
    }
    // 没有时间戳的多行歌词也算；但 `[ti:…]`/`[ar:…]` 这类标签要跳过
    if (!/^\[[a-z]+:/i.test(s)) out.push({ t: null, text: s });
  }
  return out;
}

/**
 * **挑出"能唱"的歌词行**：去掉作词/作曲/编曲/制作人这类**元信息**与空行。
 * 纯函数，可单测。
 */
export function singableLines(lines) {
  const META =
    /^(作词|作曲|编曲|制作人|出品|监制|录音|混音|母带|吉他|贝斯|鼓|键盘|和声|统筹|企划|发行|策划|封面|OP|SP|词|曲|词曲)\s*[:：]|^lyrics?\s*by|^作詞|^作曲\s*[:：]|^混音|^录音/i;
  return (lines ?? [])
    .map((x) => (typeof x === 'string' ? x : x?.text))
    .map((s) =>
      String(s ?? '')
        // QQ 音乐的 `nobase64=1` 会带 HTML 实体（`&apos;` 等），顺手解开
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
        .trim(),
    )
    .filter((s) => s && !META.test(s));
}

/**
 * ⚠️ **去掉歌词正文开头的"标题行"**（2026-10-11 实测：QQ 音乐的《稻香》正文第一行是
 * `稻香 - 周杰伦 (Jay Chou)`，会让"这是第 N 句"整体偏 1，接歌时也容易被当成歌词）。
 * 判据：LRC 里有 `[ti:歌名]` 标签，而第一行**包含歌名**且很短 → 判为标题行丢掉。
 * 纯函数，可单测。
 */
export function dropTitleLine(lines, rawLrc = '') {
  const list = [...(lines ?? [])];
  const ti = String(rawLrc ?? '').match(/\[ti:([^\]]+)\]/i);
  const title = (ti?.[1] ?? '').trim();
  if (!list.length || !title) return list;
  const first = list[0];
  if (first.length <= title.length + 24 && first.includes(title)) return list.slice(1);
  return list;
}
/** 归一：去掉标点/空白，只留字与字母数字（接歌匹配用）。 */
export function normalizeLine(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？、；：""''（）《》…—～·,.!?;:"'()<>\[\]{}~\-]/g, '');
}

/**
 * 两行相似度（0~1）：用"公共字符占比"，对中文短句够用、不怕标点差异。
 * ⚠️ 带**长句惩罚**：只看"短句是否被长句包含"的话，一整段话只要含这句就得满分。
 */
export function lineSimilarity(a, b) {
  const x = normalizeLine(a);
  const y = normalizeLine(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const pool = new Map();
  for (const ch of long) pool.set(ch, (pool.get(ch) ?? 0) + 1);
  let hit = 0;
  for (const ch of short) {
    const n = pool.get(ch) ?? 0;
    if (n > 0) {
      hit += 1;
      pool.set(ch, n - 1);
    }
  }
  const base = hit / short.length;
  const ratio = long.length / Math.max(1, short.length);
  return base * (ratio <= 2 ? 1 : Math.min(1, 2 / ratio));
}

/**
 * **接歌**：从歌词里找"他刚唱的那句"，把**后面几句**给出来（纯函数，可单测）。
 * 找不到（低于阈值）返回 null —— 调用方要如实说"这句我没在歌词里找到"，**别硬接**。
 */
export function pickNextLines(lines, userLine, { count = 2, minScore = 0.6 } = {}) {
  const list = (lines ?? []).map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!list.length || !String(userLine ?? '').trim()) return null;
  let best = { index: -1, score: 0 };
  list.forEach((line, i) => {
    const s = lineSimilarity(line, userLine);
    if (s > best.score) best = { index: i, score: s };
  });
  if (best.index < 0 || best.score < minScore) return null;
  const next = list.slice(best.index + 1, best.index + 1 + Math.max(1, Math.min(6, Number(count) || 2)));
  return { matched: list[best.index], index: best.index, score: Number(best.score.toFixed(3)), next };
}

/** 去掉歌名里的括号后缀（`晴天(深情版)` → `晴天`），用于"原唱优先"排序与"是不是翻唱"判断。 */
export function baseSongName(name) {
  return String(name ?? '')
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/** 把候选排序：**歌名与搜索词完全一样** > 去括号后一样 > 其余（同档内保持源站顺序）。 */
function rankByExact(list, q) {
  const want = baseSongName(q);
  const raw = String(q).trim();
  const tier = (s) => (String(s.name).trim() === raw ? 0 : baseSongName(s.name) === want ? 1 : 2);
  return list.map((s, i) => ({ s, i, t: tier(s) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.s);
}

// ─────────────────────────── QQ 音乐 ───────────────────────────

const QQ_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
const QQ_LYRIC = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';

async function qqSearch(keyword, { limit = 6, fetchImpl = fetch } = {}) {
  const url = `${QQ_SEARCH}?w=${encodeURIComponent(keyword)}&format=json&n=${Math.max(1, Math.min(20, (Number(limit) || 6) * 2))}&p=1&new_json=1&cr=1`;
  const r = await fetchImpl(url, { headers: HEADERS.qq });
  if (!r.ok) return [];
  const data = await r.json();
  const list = data?.data?.song?.list ?? [];
  return list.map((s) => ({
    source: 'qq',
    id: String(s.mid ?? s.songmid ?? ''),
    name: String(s.name ?? s.songname ?? ''),
    artists: (s.singer ?? []).map((a) => a.name).join('/'),
    album: String(s.album?.name ?? s.albumname ?? ''),
    durationSec: Number(s.interval ?? 0) || 0,
  }));
}

async function qqLyrics(mid, { fetchImpl = fetch } = {}) {
  const empty = { lyric: '', translated: '', lines: [] };
  if (!mid) return empty;
  // ⚠️ `nobase64=1` 才是明文；不带它拿到的是 base64（还要再解一层）。Referer 必须带。
  const url = `${QQ_LYRIC}?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1&g_tk=5381`;
  const r = await fetchImpl(url, { headers: HEADERS.qq });
  if (!r.ok) return empty;
  const data = await r.json();
  if (Number(data?.retcode ?? 0) !== 0) return empty;
  const lyric = String(data?.lyric ?? '');
  const translated = String(data?.trans ?? '');
  return { lyric, translated, lines: dropTitleLine(singableLines(parseLrc(lyric)), lyric) };
}

// ─────────────────────────── 网易云（兜底） ───────────────────────────

const NE_SEARCH = 'https://music.163.com/api/search/get/web';
const NE_LYRIC = 'https://music.163.com/api/song/lyric';

async function neSearch(keyword, { limit = 6, type = 1, fetchImpl = fetch } = {}) {
  // `type=1` 按歌名/歌手；**`type=1006` 是按歌词检索**（实测：「爱你孤身走暗巷」→《孤勇者》）
  const url = `${NE_SEARCH}?s=${encodeURIComponent(keyword)}&type=${type}&limit=${Math.max(1, Math.min(20, (Number(limit) || 6) * 2))}`;
  const r = await fetchImpl(url, { headers: HEADERS.netease });
  if (!r.ok) return [];
  const data = await r.json();
  return (data?.result?.songs ?? []).map((s) => ({
    source: 'netease',
    id: String(s.id ?? ''),
    name: String(s.name ?? ''),
    artists: (s.artists ?? []).map((a) => a.name).join('/'),
    album: String(s.album?.name ?? ''),
    durationSec: Math.round((Number(s.duration) || 0) / 1000),
  }));
}

async function neLyrics(id, { fetchImpl = fetch } = {}) {
  const empty = { lyric: '', translated: '', lines: [] };
  if (!id) return empty;
  const r = await fetchImpl(`${NE_LYRIC}?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`, { headers: HEADERS.netease });
  if (!r.ok) return empty;
  const data = await r.json();
  const lyric = String(data?.lrc?.lyric ?? '');
  const translated = String(data?.tlyric?.lyric ?? '');
  return { lyric, translated, lines: dropTitleLine(singableLines(parseLrc(lyric)), lyric) };
}

// ─────────────────────────── 对外的统一接口 ───────────────────────────

/**
 * 按歌名/歌手搜歌（**多源**：先 QQ 再网易云；某一源没结果就换下一个）。
 * 每个候选都带 `source`，取歌词时要一起传回去。
 * @returns {Promise<Array<{source:'qq'|'netease', id:string, name:string, artists:string, album:string, durationSec:number}>>}
 */
export async function searchSongs(name, { limit = 3, sources = SOURCES, fetchImpl = fetch } = {}) {
  const q = String(name ?? '').trim();
  if (!q) return [];
  const out = [];
  for (const src of sources) {
    // eslint-disable-next-line no-await-in-loop
    const list = src === 'qq' ? await qqSearch(q, { limit, fetchImpl }).catch(() => []) : await neSearch(q, { limit, fetchImpl }).catch(() => []);
    if (list.length) out.push(...rankByExact(list, q));
  }
  // 去重（同源同 id）+ 截断
  const seen = new Set();
  return out.filter((s) => (seen.has(`${s.source}:${s.id}`) ? false : (seen.add(`${s.source}:${s.id}`), true))).slice(0, Math.max(1, Math.min(10, Number(limit) || 3)));
}

/**
 * 取某个候选的歌词。`cand` 要带 `source` 与 `id`（QQ 的 id 是 songmid）。
 * @returns {Promise<{lyric:string, translated:string, lines:string[]}>}
 */
export async function fetchLyrics(cand, { fetchImpl = fetch } = {}) {
  const empty = { lyric: '', translated: '', lines: [] };
  if (!cand) return empty;
  // 兼容老调用：直接传 id（当时只有网易云）
  const source = typeof cand === 'object' ? cand.source : 'netease';
  const id = typeof cand === 'object' ? cand.id : cand;
  if (!id) return empty;
  try {
    return source === 'qq' ? await qqLyrics(id, { fetchImpl }) : await neLyrics(id, { fetchImpl });
  } catch {
    return empty;
  }
}

/**
 * **按歌词找歌**（他唱一句，我们查是哪首歌）。
 * QQ 的搜索天然按歌词匹配；网易云要 `type=1006`（普通搜索只按歌名/歌手）。
 */
export async function searchByLyric(line, { limit = 6, sources = SOURCES, fetchImpl = fetch } = {}) {
  const q = String(line ?? '').trim();
  if (q.length < 4) return [];
  const out = [];
  for (const src of sources) {
    // eslint-disable-next-line no-await-in-loop
    const list = src === 'qq' ? await qqSearch(q, { limit, fetchImpl }).catch(() => []) : await neSearch(q, { limit, type: 1006, fetchImpl }).catch(() => []);
    if (list.length) out.push(...list);
  }
  const seen = new Set();
  return out.filter((s) => (seen.has(`${s.source}:${s.id}`) ? false : (seen.add(`${s.source}:${s.id}`), true))).slice(0, Math.max(1, Math.min(20, Number(limit) || 6)));
}

/**
 * **"他说一句歌词 → 认出是哪首歌"**（用户 2026-10-11 明确要求：
 * 「能我说歌词他知道是什么歌也能接上（接上不强求，想接就接，但要他知道是什么歌）」）。
 *
 * 两条路，**都必须核对**（猜错会被当场拦住，不许只凭猜就回答）：
 *   ① 给了 `song`（模型自己猜的歌名）→ 搜它、取歌词、**核对这句在不在里面**；
 *   ② 没给 → 用**歌词检索**找候选，逐个取歌词核对。
 *
 * @returns {{song:string, artists:string, source:string, id:string, matched:string, index:number,
 *            score:number, next:string[], via:'guess'|'lyric-search', cover:boolean}|null}
 */
export async function identifySong(line, { song = '', artist = '', sources = SOURCES, fetchImpl = fetch, maxProbe = 4 } = {}) {
  const q = String(line ?? '').trim();
  if (q.length < 4) return null;
  const verify = async (cand, via) => {
    const L = await fetchLyrics(cand, { fetchImpl });
    if (!L.lines.length) return null;
    const m = pickNextLines(L.lines, q, { count: 2, minScore: 0.8 });
    if (!m) return null;
    return {
      song: cand.name,
      artists: cand.artists,
      source: cand.source,
      id: cand.id,
      matched: m.matched,
      index: m.index,
      score: m.score,
      next: m.next,
      via,
      // 歌名带括号后缀（`晴天(深情版)`）基本就是翻唱/改编 —— 提示调用方别把它当原唱
      cover: baseSongName(cand.name) !== String(cand.name).trim(),
    };
  };
  if (String(song ?? '').trim()) {
    const list = await searchSongs(String(song).trim(), { limit: 3, sources, fetchImpl });
    const a = String(artist ?? '').trim();
    const ordered = a ? [...list.filter((x) => x.artists.includes(a)), ...list.filter((x) => !x.artists.includes(a))] : list;
    for (const c of ordered.slice(0, 3)) {
      // eslint-disable-next-line no-await-in-loop
      const hit = await verify(c, 'guess');
      if (hit) return hit;
    }
    return null; // 猜的这首里没有这句 → 让调用方如实说"没认出来"
  }
  const cands = await searchByLyric(q, { limit: 8, sources, fetchImpl });
  for (const c of cands.slice(0, Math.max(1, Math.min(8, Number(maxProbe) || 4)))) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await verify(c, 'lyric-search');
    if (hit) return hit;
  }
  return null;
}

/**
 * **"他在玩接歌 / 问歌"的提示**（2026-10-11 加，跟 `timeRecallHint` 一个思路）。
 *
 * 为什么需要：歌词工具默认不会被想起 —— 而模型对歌词的"记忆"恰恰是最不可靠的
 * （会记串、编词）。所以在**识别到这类消息**时补一行，把该调的工具直接点出来
 * （约 25 token，只在这类消息上补）。
 *
 * 判据保守：出现「接歌/唱歌/唱一句/歌词/下一句/什么歌/哪首歌」这类词，
 * 或者消息里带引号的一段像歌词的话。纯聊天（"今天天气好"）不补。
 */
export function singHint(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 120) return '';
  const asked = /接歌|唱歌|唱一句|唱首|唱一|和歌|对歌|歌词|下一句|下一段|什么歌|哪首歌|这是什么歌|歌名/.test(raw);
  if (!asked) return '';
  return (
    '【歌词线索】他这话跟歌词/唱歌有关。**歌词必须用 lyrics 工具查真实的**（别凭记忆背，会记串）。' +
    '他**说/唱了一句歌词**时：`lyrics({action:"identify", line:"他那句"})` → 会告诉你是哪首歌、' +
    '并给出下一句（接不接随你）；他直接说歌名时用 `action:"get"`。' +
    '工具说"没认出来/没歌词"，就**如实说**，绝不许自己编歌名或歌词。'
  );
}
/** 把歌词拼成给模型看的文本（**有上限**，别把上下文撑爆）。 */
export function lyricsForModel({ title = '', artists = '', lines = [], maxChars = 1200, maxLines = 60 } = {}) {
  const list = (lines ?? []).slice(0, Math.max(1, Math.min(200, Number(maxLines) || 60)));
  if (!list.length) return '';
  const body = list.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const head = `《${title}》${artists ? ` - ${artists}` : ''}（共 ${lines.length} 句，这里给前 ${list.length} 句）`;
  const out = `${head}\n${body}`;
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}
