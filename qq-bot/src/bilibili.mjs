/**
 * B站（哔哩哔哩）的公开数据源。
 *
 * **为什么用它**：找梗这件事 Bing 完全不行（实测搜「电一电 是什么梗」返回字典页），
 * 而 B站搜「X 是什么梗」返回的就是「网梗指南」「梗百科」这类专门讲梗的视频，
 * 标题本身就把答案说了一半。实测搜「电一电 是什么梗」第一条就是
 * 「电击萝莉控是什么梗？」——正是要找的那个。
 *
 * **不需要登录**。实测（2026-10-06）：
 *   - 热搜词 `search/square` ✅ 200 / code=0
 *   - 热门榜 `ranking/v2` ✅ 200 / code=0
 *   - 搜索 API `search/type` ❌ 412（反爬，要 cookie + WBI 签名）——
 *     但**搜索页 HTML 里嵌了结果**（JS 字面量，不是 JSON），用正则能挖出来。
 *   - 抖音 ❌ 返回空的 JS 壳（72KB，body 为空），没有登录和签名拿不到任何东西。
 */

import { inflateRawSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', referer: 'https://www.bilibili.com/' };
const TIMEOUT_MS = 15000;

/** 凭证文件：仓库根目录的 `bili-cookie.txt`（第一行非注释内容就是 SESSDATA）。 */
const COOKIE_FILE = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'bili-cookie.txt');

/**
 * 从 `bili-cookie.txt` 里读**某一个键**的值。两种文件格式都必须认（2026-10-08 拆两个口时定的）：
 *
 *   · `SESSDATA=xxxx` / `bili_jct=yyyy`  ← 新格式：**一行一个键**，两个口互不干扰
 *   · `xxxx`（裸值，整行就是一个值）        ← 老格式：只可能是 SESSDATA，继续兼容
 *
 * ⚠️ 老写法（"取第一条非注释行"）在文件变成 `KEY=VALUE` 之后会把**整行当值**返回，
 * 于是 cookie 里出现 `SESSDATA=SESSDATA=…` —— 而且是**静默**坏掉（接口只会告诉你"未登录"）。
 * 所以这里必须按键取值，并且**只把裸值当 SESSDATA**（别的键遇到裸值就当没有）。
 */
/**
 * @param {string} key 键名（大小写不敏感：用户可能把 `SESSDATA` 写成小写）
 * @param {string|null} [text] 传字符串就解析这段文本（**给自测用**），传 null 才去读真实文件
 *   —— 这样断言不必去动用户那份凭证文件（那是不可逆的家当，测试永远不该碰）
 */
export function readCookieValue(key, text = null) {
  const want = String(key ?? '').trim().toUpperCase();
  if (!want) return '';
  let body = '';
  try {
    if (text !== null) {
      body = String(text);
    } else {
      if (!existsSync(COOKIE_FILE)) return '';
      body = readFileSync(COOKIE_FILE, 'utf8');
    }
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) {
        // 有 `=`：这是个 KEY=VALUE 行。**键不匹配就继续找下一行**（别顺手把 bili_jct 当成 SESSDATA）
        if (t.slice(0, eq).trim().toUpperCase() === want) return t.slice(eq + 1).trim();
        continue;
      }
      if (want === 'SESSDATA') return t; // 裸值只认 SESSDATA（老格式）
    }
  } catch {
    /* 读不到就当没登录，功能降级而不是报错 */
  }
  return '';
}

/**
 * 读登录态（SESSDATA）。顺序：环境变量 `BILI_SESSDATA` → `bili-cookie.txt`。
 *
 * **为什么需要它**（2026-10-07 实测）：
 *   - 未登录时 `player/v2` 的 `subtitle.subtitles` **恒为空**；
 *   - 官方 AI 视频总结 `view/conclusion/get` 直接 `code=-403 访问权限不足`。
 * 带上 SESSDATA 这两个才可用 —— 而字幕就是**视频里说的话的逐字稿**，
 * 比任何语音识别方案都准、都快、都不用装东西。
 *
 * ⚠️ 这是登录凭证，等价于账号登录态：不提交、不外传、**不写进记忆文件**。
 */
export function readSessData() {
  const fromEnv = String(process.env.BILI_SESSDATA ?? '').trim();
  if (fromEnv) return fromEnv;
  return readCookieValue('SESSDATA');
}

/**
 * 读 B站 的 **csrf（`bili_jct`）** —— 点赞 / 投币 / 收藏这类**写操作**必须带它。
 *
 * 与 SESSDATA **分开存、分开读**（用户 2026-10-08 明确要求）：两个值用途不同、
 * 失效节奏也不同，混在一行里改一个动全身。环境变量可用 `BILI_JCT` 覆盖。
 */
export function readBiliJct() {
  const fromEnv = String(process.env.BILI_JCT ?? '').trim();
  if (fromEnv) return fromEnv;
  return readCookieValue('bili_jct');
}

/**
 * 设备指纹（buvid3 / buvid4）。
 *
 * **为什么必须要它**（2026-10-07 实测）：只带 SESSDATA 时，`player/v2` 的
 * `subtitle_url` **八次里七次是空的**，条目数还在 12 / 1 之间乱跳 —— 那是 B站
 * 认不出「浏览器」时的灰度降级。补上设备指纹后成功率明显上去（6 次里 4 次有 URL）。
 * 这个值我们自己就能取，**不需要用户提供**。
 */
let deviceCookieCache = null;
async function getDeviceCookie() {
  if (deviceCookieCache !== null) return deviceCookieCache;
  try {
    const j = await getJson('https://api.bilibili.com/x/frontend/finger/spi');
    const b3 = j?.data?.b_3 ?? '';
    const b4 = j?.data?.b_4 ?? '';
    deviceCookieCache = [b3 && `buvid3=${b3}`, b4 && `buvid4=${b4}`].filter(Boolean).join('; ');
  } catch {
    deviceCookieCache = '';
  }
  return deviceCookieCache;
}

/** 有登录态就带 Cookie（SESSDATA + bili_jct + 设备指纹），没有就退回匿名请求。 */
async function authHeaders() {
  const parts = [];
  const sess = readSessData();
  if (sess) parts.push(`SESSDATA=${sess}`);
  const jct = readBiliJct(); // csrf：写操作要它，读操作带着也无害
  if (jct) parts.push(`bili_jct=${jct}`);
  const dev = await getDeviceCookie();
  if (dev) parts.push(dev);
  return parts.length ? { ...HEADERS, cookie: parts.join('; ') } : HEADERS;
}

async function getText(url, headers = HEADERS) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function getJson(url, headers = HEADERS) {
  return JSON.parse(await getText(url, headers));
}

/** **带登录态**的 GET（给"要按自己的身份查"的接口用，例如收藏夹列表要带 mid）。 */
export async function getJsonAuthed(url) {
  return getJson(url, await authHeaders());
}

/**
 * **写操作**用的 POST（B站 的写接口一律 `application/x-www-form-urlencoded` + `csrf=bili_jct`）。
 *
 * 为什么要单独有它：`fetch_page` / 搜索那些都是只读 GET，而点赞/投币/收藏/关注是**真的改账号状态**，
 * 一旦发出去就收不回来（点赞能取消、投币不能）—— 所以这里的失败要**原样报出来**，
 * 不能像读操作那样悄悄吞掉。
 *
 * @param {string} url 接口地址
 * @param {Record<string, string|number>} fields 表单字段（`csrf` 会自动补上，除非显式传了）
 * @param {{jct?:string}} [opts] `jct` 可注入（**给自测用**：能离线验"没有 csrf 时怎么回"，不必打真接口）
 * @returns {Promise<{code:number, message:string, data:any}>} B站 的统一返回信封（code=0 才算成功）
 */
export async function postForm(url, fields = {}, opts = {}) {
  const jct = opts.jct === undefined ? readBiliJct() : String(opts.jct ?? '');
  if (!jct) {
    // 早失败、说清楚：没有 csrf 时 B站 会返回一个含糊的 -111，看起来像"被风控了"
    return { code: -1, message: '没有 bili_jct（csrf）—— 面板「B站登录」第二个框里填一下再做写操作', data: null };
  }
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.set(k, String(v));
  if (!body.has('csrf')) body.set('csrf', jct);
  const H = await authHeaders();
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    const j = JSON.parse(text);
    return { code: Number(j?.code ?? -1), message: String(j?.message ?? ''), data: j?.data ?? null };
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 80)}`);
  }
}

/** 把 JS 字符串字面量里的转义还原（`\u002F` → `/`，`\u003C` → `<`）。 */
export function unescapeJsText(raw) {
  return String(raw ?? '')
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/<[^>]*>/g, '') // <em class="keyword"> 高亮标签
    .replace(/\s+/g, ' ')
    .trim();
}

function jsField(chunk, key) {
  const m = chunk.match(new RegExp(`${key}:"((?:[^"\\\\]|\\\\.){1,400})"`));
  return m ? unescapeJsText(m[1]) : '';
}

/**
 * 从搜索页 HTML 里挖出视频条目。
 *
 * 页面里的结果是 **JS 字面量**（`author:"…"`、`bvid:"…"`、`title:"…"`），不是 JSON。
 *
 * ⚠️ **页面里有 12 个 `result_type:xxx,data:[…]` 块，只有一个是真搜索结果。**
 * 踩过：不筛选就把「推荐位」当成搜索结果——搜「电一电 是什么梗」返回的是
 * 「我们就是电！跟电干谁能干过电？！！」，而真正的第一条
 * 「电击萝莉控是什么梗？【网梗指南】」被挤掉了。
 *
 * 判别方式用**字段**而不是块名：真结果块里的条目带 `arcurl:`（其余块是空的或非视频）。
 * 块名 `f` 是压缩后的变量名，换个构建就可能变，靠不住。
 *
 * ⚠️ **`author` 在 `bvid` 之前**——一开始按 `bvid:"` 切段再往后找 author，
 * 拿到的其实是下一条的作者，UP 主全是错位的。所以用一条正则按顺序一起抓。
 *
 * ⚠️ **尾部那个 `([\s\S]{0,1200}?)` 必须配 `(?=author:"|$)` 这个边界**——
 * 写成贪婪的 `{0,1200}` 会把**下一条结果整个吞掉**，于是只解析出 1 条。
 *
 * 抽成纯函数是为了能用固定 HTML 做断言——不然"搜索结果对不对"只能靠真去搜一次。
 */
const RESULT_RE =
  /author:"((?:[^"\\]|\\.){0,80})"[\s\S]{0,400}?bvid:"(BV[0-9A-Za-z]{8,14})"[\s\S]{0,40}?title:"((?:[^"\\]|\\.){1,400})"([\s\S]{0,1200}?)(?=author:"|$)/g;

/** 真搜索结果块的特征字段。 */
const REAL_BLOCK = /arcurl:"/;

export function parseBilibiliSearch(html, max = 6) {
  const src = String(html ?? '');
  const out = [];
  const seen = new Set();

  for (const block of src.split(/result_type:\w+,data:\[/).slice(1)) {
    if (out.length >= max) break;
    if (!REAL_BLOCK.test(block.slice(0, 6000))) continue; // 推荐位 / 空块，跳过
    for (const m of block.matchAll(RESULT_RE)) {
      if (out.length >= max) break;
      const [, authorRaw, bvid, titleRaw, rest] = m;
      if (seen.has(bvid)) continue;
      const title = unescapeJsText(titleRaw);
      if (!title) continue;
      seen.add(bvid);
      const play = rest.match(/play:(\d+)/);
      const tag = rest.match(/tag:"((?:[^"\\]|\\.){0,300})"/);
      out.push({
        bvid,
        title,
        author: unescapeJsText(authorRaw),
        views: play ? Number(play[1]) : null,
        // 标签是找梗的线索：讲「电一电」那个视频的标签里直接有「直接电,国家电网」
        tags: tag ? unescapeJsText(tag[1]) : '',
        url: `https://www.bilibili.com/video/${bvid}`,
      });
    }
  }
  return out;
}

/** 从热搜接口的 JSON 里取热词。 */
export function parseHotWords(json, max = 12) {
  const t = json?.data?.trending;
  const list = t?.list ?? t?.top_list ?? [];
  const out = [];
  for (const item of list) {
    const w = unescapeJsText(item?.keyword ?? item?.show_name ?? '');
    if (w && !out.includes(w)) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** 从热门榜 JSON 里取视频。 */
export function parseRanking(json, max = 8) {
  const list = json?.data?.list ?? [];
  return list.slice(0, max).map((v) => ({
    title: unescapeJsText(v?.title ?? ''),
    author: unescapeJsText(v?.owner?.name ?? ''),
    views: Number(v?.stat?.view ?? 0) || null,
    bvid: String(v?.bvid ?? ''),
    url: v?.bvid ? `https://www.bilibili.com/video/${v.bvid}` : '',
  }));
}

/** 搜 B站。适合「X 是什么梗」「X 怎么玩」这类找内容的问题。 */
export async function searchBilibili({ keyword, count = 6 } = {}) {
  const q = String(keyword ?? '').trim();
  if (!q) return '没给搜索词。';
  const n = Math.min(10, Math.max(1, Number(count) || 6));
  try {
    const html = await getText(`https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}`);
    const items = parseBilibiliSearch(html, n);
    if (!items.length) return `B站没搜到「${q}」的视频。`;
    return items
      .map((it, i) => {
        const v = it.views ? `${(it.views / 10000).toFixed(1)}万播放` : '';
        const tags = it.tags ? `\n   标签：${it.tags}` : '';
        return `${i + 1}. ${it.title}${it.author ? `　UP：${it.author}` : ''}${v ? `　${v}` : ''}${tags}\n   ${it.url}`;
      })
      .join('\n');
  } catch (err) {
    return `B站搜索失败：${err.message}`;
  }
}

/* ---------------- 单个视频：详情 + 弹幕 ---------------- */

/**
 * 从各种输入里认出 bvid：完整网址、带参数的网址、或者裸的 BV 号。
 * 模型经常会把整个 URL 塞进来，所以这里要宽容一点。
 */
export function parseBvid(input) {
  const m = String(input ?? '').match(/BV[0-9A-Za-z]{8,14}/);
  return m ? m[0] : null;
}

/**
 * 把「用户实际会发的东西」变成 bvid。
 *
 * 为什么需要它：`parseBvid` 只会从字符串里**抓 BV 号**，而用户从手机分享出来的
 * 往往是 **`b23.tv` 短链**（里面根本没有 BV 号）或者 **`av` 号**。
 * 之前遇到这两种就回一句「这不是一个 B站视频号」—— 用户看到的就是「为啥必须给 BV 号」。
 *
 * 三种都认：裸 BV 号 / 带 BV 号的完整网址 / `b23.tv` 短链（跟一次重定向）/ `av` 号（查一次接口）。
 */
export async function resolveBvid(input) {
  const raw = String(input ?? '').trim();

  const direct = parseBvid(raw);
  if (direct) return direct;

  // b23.tv 短链：**不跟随重定向**，直接从 Location 里抠 BV 号（省一次下载）
  const short = raw.match(/https?:\/\/b23\.tv\/[A-Za-z0-9]+/);
  if (short) {
    try {
      const res = await fetch(short[0], {
        redirect: 'manual',
        headers: HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const bv = parseBvid(res.headers.get('location') ?? '');
      if (bv) return bv;
      // 少数情况下会直接 200 返回落地页
      if (res.status === 200) {
        const bv2 = parseBvid(await res.text());
        if (bv2) return bv2;
      }
    } catch {
      /* 短链失败就继续往下试 */
    }
  }

  // av 号：查一次接口换 bvid
  const av = raw.match(/\bav(\d+)/i);
  if (av) {
    try {
      const j = await getJson(`https://api.bilibili.com/x/web-interface/view?aid=${av[1]}`);
      if (j?.data?.bvid) return j.data.bvid;
    } catch {
      /* 交给调用方报错 */
    }
  }

  return null;
}

/**
 * 解析弹幕 XML。
 *
 * **弹幕是"视频里到底有什么文字"的唯一免费来源**（2026-10-06 确认）：
 *   - 相关 12 个视频**全是 0 条字幕**，B站没有给它们生成 AI 字幕；
 *   - 简介常常是空的（那个 61 万播放的梗指南简介 0 字）；
 *   - 匿名评论接口只返回 3 条。
 * 弹幕却不用登录就能拿，而且观众经常把关键句、梗的原话、对内容的吐槽刷出来——
 * 实测正是弹幕告诉我们「DANKING 是照着稿子念的」（"念稿呢自己都记不住""直接看电脑读的"）。
 */
export function parseDanmaku(xml, max = 30) {
  const out = [];
  const seen = new Set();
  for (const m of String(xml ?? '').matchAll(/<d p="[^"]*">([^<]*)<\/d>/g)) {
    const t = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

async function getDanmaku(cid, max = 30) {
  const res = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let xml;
  try {
    xml = inflateRawSync(buf).toString('utf8'); // 接口返回 deflate
  } catch {
    xml = buf.toString('utf8');
  }
  return parseDanmaku(xml, max);
}

/**
 * 取视频字幕 —— **视频里说的话的逐字稿**。需要登录。
 *
 * 这是「看视频内容」的正解：不用下载音频、不用语音识别、不用装任何东西，
 * 而且字幕是 B站自己对齐好的逐句文本，**比 ASR 更准**。
 *
 * @returns {Promise<{lang:string, lines:string[]}|null>} 没登录 / 该视频没字幕 → null
 */
/**
 * 取「进度条预览图」—— 一张**雪碧图**，里面是整个视频的缩略图网格。
 *
 * **这是「看画面」最便宜的一条路**（2026-10-07 实测）：
 *   · 不用下载视频、不用 ffmpeg、不用登录；
 *   · 默认 10×10 = 100 格、每格 160×90、相邻两格约隔 5 秒；
 *   · 一张图约 60 KB，交给视觉模型约 950 prompt token。
 * 把整张图交给模型后，它真读出了「复古歌舞片、多人、有麦克风和餐桌、
 * 镜头在特写与全景间跳切」—— 与那支 MV 的实际内容吻合。
 *
 * ⚠️ 每格只有 160×90，所以**只能看场景 / 人物 / 大致变化，看不出细节动作**。
 */
export async function getVideoShot(bvid, cid) {
  let r;
  try {
    r = await getJson(`https://api.bilibili.com/x/player/videoshot?bvid=${bvid}&cid=${cid}&index=1`);
  } catch {
    return null;
  }
  if (r?.code !== 0 || !r?.data?.image?.length) return null;

  const d = r.data;
  let url = String(d.image[0]);
  if (url.startsWith('//')) url = `https:${url}`;

  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return {
      base64: buf.toString('base64'),
      mime: (res.headers.get('content-type') ?? '').split(';')[0] || 'image/jpeg',
      xLen: Number(d.img_x_len) || 10,
      yLen: Number(d.img_y_len) || 10,
      xSize: Number(d.img_x_size) || 160,
      ySize: Number(d.img_y_size) || 90,
      times: Array.isArray(d.index) ? d.index : [],
      bytes: buf.length,
    };
  } catch {
    return null;
  }
}

/**
 * 字幕地址的**指纹**：同一份字幕文件必须给出同一个指纹，否则下面那条「≥2 票」的门禁永远不成立。
 *
 * ⚠️ 2026-10-08 实测踩的坑（这条链路的命门）：旧写法用正则抠 `subtitle/<hex>.json`，
 * 而**AI 字幕**（现在最主流的类型）地址长这样：
 *   `https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/<32 位十六进制>?<每次都会变的签名参数>`
 * 正则匹配不上 → 退回"**整条 URL** 当指纹" → 签名参数每次都变 → 每次都被算成不同的文件 →
 * 票数永远停在 1 → `getSubtitle()` 对**所有** AI 字幕视频返回 null。
 * 症状极具迷惑性：`player/v2` 明明列出了 `ai-zh`、直接拉那个 JSON 也能拿到 93 句，
 * 但生产代码就是"没拿到可信的字幕"，于是机器人一直说"这条视频没字幕/别猜内容"。
 *
 * 指纹取 **pathname**（丢掉会变的 query）：同一份文件 → 同一指纹 ✓；换了文件 → 不同指纹 ✓
 * （防串号的能力不变：串过来的别家字幕是**另一个路径**，照样攒不到票）。
 */
export function subtitleFingerprint(url) {
  let u = String(url ?? '').trim();
  // ⚠️ B站 有时返回**协议相对**地址（`//aisubtitle.hdslb.com/...`）——
  // 不先补协议的话 `new URL()` 会抛，落到下面的兜底分支，于是同一个文件算出**两个不同指纹**，
  // 票又被拆散（实测：`//…/prod/ABC?a=1` 与 `https://…/prod/ABC?a=2` 必须同指纹）。
  if (u.startsWith('//')) u = `https:${u}`;
  try {
    return new URL(u).pathname;
  } catch {
    return u.split('?')[0];
  }
}

export async function getSubtitle(bvid, cid, { maxLines = 500, attempts = 6 } = {}) {
  if (!readSessData()) return null;
  const H = await authHeaders();

  // 实测（2026-10-07）：B站 的 `player/v2` **极不稳定** ——
  //   · 同一请求连打，有时 12 条字幕、有时 1 条、有时 0 条；
  //   · 大多数时候 `subtitle_url` 是空的；
  //   · 更糟的是它**偶发返回别的视频的字幕**（实测拿到过完全无关的中文段子）。
  // 所以这里**打多次 + 按 URL 指纹投票**，只信多数一致的那一份；拿不到共识也要标记出来。
  const rankLang = (lan) => {
    const s = String(lan ?? '').toLowerCase();
    if (s === 'zh-cn' || s === 'zh-hans') return 0;
    if (s.startsWith('zh')) return 1;
    if (s.startsWith('en')) return 2;
    return 3;
  };

  const tally = new Map(); // 指纹 -> { count, pick, rank }
  for (let i = 0; i < Math.max(1, attempts); i += 1) {
    try {
      const r = await getJson(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, H);
      for (const s of r?.data?.subtitle?.subtitles ?? []) {
        const u = String(s?.subtitle_url ?? '').trim();
        if (!u) continue;
        const fp = subtitleFingerprint(u); // 见 subtitleFingerprint 的说明：不能把签名参数算进指纹
        const cur = tally.get(fp);
        if (cur) cur.count += 1;
        else tally.set(fp, { count: 1, pick: s, rank: rankLang(s?.lan) });
      }
    } catch {
      /* 这一次失败，继续打下一次 */
    }
    if ([...tally.values()].some((v) => v.count >= 2)) break; // 已有共识，不必再打
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 400));
  }

  // 票数多的优先；同票时按语言偏好（中文 > 英文 > 其它）
  const best = [...tally.values()].sort((a, b) => b.count - a.count || a.rank - b.rank);

  for (const cand of best.slice(0, 3)) {
    // **只接受拿到过 ≥2 票的候选。**
    //
    // 为什么必须这么严：单票很可能就是 B站 网关串号出来的**别的视频的字幕**——
    // 实测两次撞上（点进去是 Rick Astley 的英文歌，字幕却是「杨幂回旋镖」和
    // 「帕尼尼减肥法」）。单次请求无法自证，所以宁可不给，也不要把错的喂给模型去讲。
    if (cand.count < 2) break;
    let url = String(cand.pick.subtitle_url).trim();
    if (url.startsWith('//')) url = `https:${url}`;
    try {
      const j = await getJson(url, H);
      const body = Array.isArray(j?.body) ? j.body : [];
      const lines = body.map((x) => String(x?.content ?? '').trim()).filter(Boolean);
      if (lines.length) {
        return {
          lang: cand.pick?.lan_doc || cand.pick?.lan || '字幕',
          lines: lines.slice(0, maxLines),
          verified: true, // 能走到这里就一定 ≥2 票（见上面的门禁）
        };
      }
    } catch {
      /* 这个候选坏了，换下一个 */
    }
  }
  return null;
}

/**
 * 视频详情的**结构化**版本（给内部流程用，不给模型）。
 *
 * 为什么必须单独有它（2026-10-08 交接第一条的坑）：`videoInfo()` 返回的是**给模型看的字符串**，
 * 而「看懂视频」那条链（`src/watch.mjs` + `bot.mjs` 的 `surfOnce()`）要的是 `cid`
 * —— 拿字符串去取 `info.cid` **永远是 undefined**，于是 `getSubtitle()` 根本不会被调用，
 * 整条链**空转**（日志上只表现为"判断了一轮、什么都没发"）。
 *
 * ⚠️ 别去改 `videoInfo()` 的签名：那条路是模型工具 `bilibili_video` 在用的，返回字符串是它的契约。
 * 两个函数读的是**同一份 JSON**（`x/web-interface/view`），只是一个排版成人话、一个给代码用。
 *
 * @returns {Promise<null | {bvid:string,title:string,desc:string,pic:string,cid:number|null,
 *   duration:number,up:string,url:string}>} 认不出号 / 接口失败 / code≠0 一律 null（调用方只需判真假）
 */
export async function videoInfoRaw({ bvid } = {}) {
  const bv = await resolveBvid(bvid);
  if (!bv) return null;
  try {
    const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
    if (view?.code !== 0) return null;
    const d = view.data ?? {};
    return {
      bvid: bv,
      // `aid` 是**收藏**要用的（收藏接口吃 `rid`=aid，不吃 bvid）—— 顺手带出来，省一次请求
      aid: Number(d.aid ?? 0) || null,
      title: String(d.title ?? ''),
      desc: String(d.desc ?? ''),
      pic: String(d.pic ?? ''),
      // 分 P 视频的 cid 在 pages[0] 上，单 P 视频在顶层；两个都试
      cid: d.cid ?? d.pages?.[0]?.cid ?? null,
      duration: Number(d.duration ?? 0) || 0,
      up: String(d.owner?.name ?? ''),
      url: `https://www.bilibili.com/video/${bv}`,
    };
  } catch {
    return null;
  }
}

/**
 * 单个视频的详情 + 弹幕 + **字幕**。
 *
 * 2026-10-07 更新：接上登录态（SESSDATA）后能拿到**字幕**，那才是真正的
 * 「视频里说了什么」。未登录时退化回文字层（标题、UP、数据、简介、弹幕），
 * 并明确告诉模型**别猜内容**。
 */
export async function videoInfo({ bvid, danmakuCount = 25 } = {}) {
  const bv = await resolveBvid(bvid);
  if (!bv) {
    return (
      `认不出视频号。支持：裸 \`BV1xxxxxxxxx\`、带 BV 号的完整网址、\`b23.tv\` 短链、\`av\` 号。` +
      `你给的是：${bvid}`
    );
  }
  let view;
  try {
    view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
  } catch (err) {
    return `取视频详情失败：${err.message}`;
  }
  if (view?.code !== 0) return `取视频详情失败：${view?.message ?? view?.code}`;

  const d = view.data ?? {};
  const lines = [
    `《${d.title}》　UP：${d.owner?.name ?? '?'}`,
    `播放 ${d.stat?.view ?? '?'}　点赞 ${d.stat?.like ?? '?'}　时长 ${Math.floor((d.duration ?? 0) / 60)}分${(d.duration ?? 0) % 60}秒`,
    `https://www.bilibili.com/video/${bv}`,
  ];
  const desc = String(d.desc ?? '').trim();
  lines.push(desc ? `\n【简介】\n${desc.slice(0, 600)}` : '\n【简介】空的');

  try {
    const dm = await getDanmaku(d.cid, Math.min(40, Math.max(5, Number(danmakuCount) || 25)));
    lines.push(
      dm.length
        ? `\n【弹幕】观众在看的时候刷的（能反映视频内容，但只是观众的话，不是视频原文）：\n${dm.map((t) => `· ${t}`).join('\n')}`
        : '\n【弹幕】这条视频没有弹幕',
    );
  } catch (err) {
    lines.push(`\n【弹幕】取失败（${err.message}）`);
  }

  // 字幕：视频里说的话的逐字稿。**需要登录**（见 readSessData 的说明）。
  // 拿不到时明确说「别猜」——否则模型看到一个标题就会自己编视频内容。
  let subtitle = null;
  try {
    subtitle = await getSubtitle(bv, d.cid);
  } catch {
    /* 字幕失败不影响其它信息 */
  }

  if (subtitle) {
    lines.push(
      `\n【字幕原文】这就是视频里**说**的话（${subtitle.lang}，共 ${subtitle.lines.length} 句）：\n` +
        subtitle.lines.map((t) => `· ${t}`).join('\n'),
    );
  } else if (!readSessData()) {
    lines.push(
      '\n【字幕】**未登录**，拿不到视频里说的话。**不要猜视频内容**——' +
        '只根据上面的标题/简介/弹幕回答，并告诉用户：想看视频里到底说了啥，' +
        '需要先让我登录 B站小号（把 SESSDATA 写进 qq-bot/bili-cookie.txt）。',
    );
  } else {
    lines.push(
      '\n【字幕】已登录，但这次**没拿到可信的字幕**：要么这条视频本来就没有字幕，' +
        '要么 B站 的字幕接口这次没给出稳定结果（它确实不稳定，会偶发把别的视频的字幕串过来）。' +
        '**不要猜视频内容**，只根据上面拿到的文字层回答，并如实告诉用户「这次没取到字幕」。',
    );
  }
  return lines.join('\n');
}

/** B站现在在热什么：热搜词 + 热门视频。回答「最近有什么梗」用它。 */
export async function hotBilibili({ count = 8 } = {}) {
  const n = Math.min(20, Math.max(1, Number(count) || 8));
  const out = [];
  try {
    const words = parseHotWords(await getJson('https://api.bilibili.com/x/web-interface/search/square?limit=20'), n);
    if (words.length) out.push(`B站热搜词：\n${words.map((w, i) => `${i + 1}. ${w}`).join('\n')}`);
  } catch (err) {
    out.push(`热搜没取到（${err.message}）`);
  }
  try {
    const vids = parseRanking(
      await getJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all'),
      Math.min(8, n),
    );
    if (vids.length) {
      out.push(
        `B站热门视频：\n${vids
          .map((v, i) => `${i + 1}. ${v.title}${v.author ? `　UP：${v.author}` : ''}${v.views ? `　${(v.views / 10000).toFixed(0)}万播放` : ''}`)
          .join('\n')}`,
      );
    }
  } catch (err) {
    out.push(`热门榜没取到（${err.message}）`);
  }
  return out.join('\n\n') || 'B站数据没取到。';
}

/**
 * 热门榜的**结构化**版本（给冲浪用）：`[{title,author,views,bvid,url}]`。
 *
 * 为什么不能直接拿 `hotBilibili()` 来解析（2026-10-08 实测）：
 *   ① 它返回的是"给模型看的字符串"，**文本里根本没有链接**（只有标题/UP/播放量）
 *      → `parseSearchLines()` 抠不到 URL → 冲浪的 B站源**永远产出 0 条**；
 *   ② 靠解析人话取数据本来就脆，冲浪要的是能去重的条目（`pickFresh` 按 url/title 判重）。
 * 语义与 `hotBilibili()` 一致（同一个 `ranking/v2` 接口），只是一个排版成人话、一个给代码用。
 *
 * @returns {Promise<Array<{title:string,author:string,views:number|null,bvid:string,url:string}>>}
 *   网络失败一律返回 `[]`（冲浪那边还有别的源，不该因为 B站 挂掉就整体不干活）
 */
export async function hotBilibiliList({ count = 12 } = {}) {
  const n = Math.min(30, Math.max(1, Number(count) || 12));
  /**
   * ⚠️ 2026-10-09 用户问「为啥冲浪一直取不到东西」——实测：`ranking/v2` **不带 cookie 会回 `code=-352`（风控）**，
   * 于是这个源**长期返回 0 条**（记忆里"热门榜免登录"那条已经过时）。
   * 实测可用的两条路：
   *   · `ranking/v2` **带上 SESSDATA** → `code=0`、100 条 ✓（我们本来就有 cookie）
   *   · `popular`（热门）**完全免登录** → `code=0`、20 条 ✓（作为退路）
   * 所以：先试带 cookie 的 ranking，再退到 popular，最后才认输。
   */
  try {
    const json = await getJsonAuthed('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all');
    const list = parseRanking(json, n).filter((v) => v.url);
    if (list.length) return list;
  } catch {
    /* 没 cookie / 被风控 → 走退路 */
  }
  try {
    const json = await getJson('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1');
    return parseRanking(json, n).filter((v) => v.url);
  } catch {
    return [];
  }
}
