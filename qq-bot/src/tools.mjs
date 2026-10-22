/**
 * 机器人的「能干的事」。
 *
 * 这里只放**读、无副作用、不需要密钥**的工具。原因：
 *   - 写操作（发消息、改文件）一旦被模型乱调，代价不可逆；
 *   - 需要密钥的工具意味着多一份要管的东西，先用能白嫖的。
 *
 * ⚠️ **有副作用的「控制类」工具不在这张表里**，它们在 `src/control.mjs`：
 * 那张表是"谁都能调"的，控制类必须额外过「私聊 + 主人 + 白名单」三道闸，
 * 混在一起早晚出事。`execTool` 里按名字分流。
 *
 * 数据源实测（2026-10-06）：Open-Meteo 的 geocoding 与 forecast 都通，
 * 不需要注册也不需要 key。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { lookup } from 'node:dns/promises';
import { loadConfig } from './config.mjs';
import { parseTimeWindow } from './chatlog.mjs';
import { fetchLyrics, identifySong, lyricsForModel, pickNextLines, searchSongs } from './lyrics.mjs';
import { getVideoShot, hotBilibili, resolveBvid, searchBilibili, videoInfo } from './bilibili.mjs';
import { CONTROL_TOOL_NAMES, runControlTool } from './control.mjs';
import { REMINDER_TOOL_NAMES, runReminderTool } from './reminders.mjs';
import { MEMORY_TOOL_NAMES, runMemoryTool } from './memory.mjs';
import { QQACT_TOOL_NAMES, runQqActTool } from './qqact.mjs';
import { BILIACT_TOOL_NAMES, runBiliActTool } from './biliact.mjs';

/* ---------------- 图片 / 视频搜索 ---------------- */

const RECENT_IMAGE_URLS = new Set();
const RECENT_IMAGE_CAP = 200;

function rememberImageUrls(urls) {
  for (const u of urls) {
    if (RECENT_IMAGE_URLS.has(u)) RECENT_IMAGE_URLS.delete(u);
    RECENT_IMAGE_URLS.add(u);
  }
  while (RECENT_IMAGE_URLS.size > RECENT_IMAGE_CAP) {
    RECENT_IMAGE_URLS.delete(RECENT_IMAGE_URLS.values().next().value);
  }
}

/**
 * 这个网图地址是不是**本次会话里真的搜出来过**的？
 *
 * 这是"不能绕开搜索去发图"的那道闸：只认搜索结果，
 * 模型自己编的、凭记忆写的、或者从别处抄来的地址一律不认。
 * 没有这道闸，模型完全可以直接吐一个任意 URL 让 NapCat 去下载发送。
 */
export function isSearchedImageUrl(url) {
  return RECENT_IMAGE_URLS.has(String(url ?? ''));
}

/* ---------------- 「这张图是不是发过了」——2026-10-07 用户报「找图重复」的正面回答 ----------------
 *
 * 当时的现场（`logs/bot-2026-10-07.log` 11:57–11:59）：主人说「帮我找可露凯的图」，
 * 发出两张；接着说「再来两张」，又发出两张 —— 他回「我的意思你发的图一样」。
 *
 * 两个**各自独立**的原因，缺一个都还会重：
 *   ① `bot.mjs` 记「已发过的地址」时写的是 `g.url`，而那个对象**根本没有 url 字段**（只有 buf）
 *      → 记进去的全是 `undefined`，跨轮排除从来没生效过；
 *   ② 只比地址不够 —— 同一个文件换个图床、或者换个变换后缀，地址就不同了。
 *      实测：`可露凯` 翻到第 2 页时 `wiki.42lab.cloud/.../Lpic_hk416_happyzoo.png`
 *      与第 1 页那条**字节完全相同**，地址却不一样。
 *
 * 所以判重做成两层：**归一化地址**（省一次下载）+ **内容 sha256**（真判据）。
 */

/**
 * 图片地址归一化。**只用来判重，不用来下载**（下载要用原地址，否则可能 404）。
 *
 * 为什么要归一：同一次搜索里同一张图会以多种写法出现 ——
 *   · 百度百科：`/pic/xxx?x-bce-process=image/resize,...`
 *   · 18183：`xxx.jpg@!18183`
 *   · 堆糖：`xxx.thumb.1000_0.jpeg`
 * 这些后缀和查询串跟"是哪张图"无关，带上它们比地址永远比不中。
 */
export function normalizeImageUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return '';
  }
  if (!/^https?:$/i.test(u.protocol)) return '';
  let path = u.pathname || '';
  try {
    path = decodeURIComponent(path);
  } catch {
    /* 百分号编码坏了就按原样用 */
  }
  path = path
    .replace(/\.thumb\.\d+_\d+(?=\.)/i, '') // 堆糖缩略图后缀
    .replace(/-bkimg-(?:proc|process)[^/]*$/i, '') // 百度百科 smart/xxx-bkimg-process,...
    .replace(/@![a-z0-9]+$/i, ''); // 18183 之类
  return `${u.hostname.toLowerCase()}${path}`;
}

/** 地址身份键（`u:` 开头）；地址不成样子时给空串（调用方自己过滤）。 */
export function imageUrlKey(url) {
  const n = normalizeImageUrl(url);
  return n ? `u:${n}` : '';
}

/** 内容身份键（`s:` 开头）。传 Buffer 会顺手算 sha256，传十六进制串直接用。 */
export function imageShaKey(bufOrHex) {
  const hex = Buffer.isBuffer(bufOrHex) ? sha256Hex(bufOrHex) : String(bufOrHex ?? '').trim().toLowerCase();
  return hex ? `s:${hex}` : '';
}

/** 图片二进制的 sha256（十六进制）。 */
export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 这批身份键里只要有**一个**在 `seen` 里，就是发过的。 */
export function isSeenImage(keys, seen) {
  if (!seen || typeof seen.has !== 'function') return false;
  for (const k of keys) if (k && seen.has(k)) return true;
  return false;
}

/**
 * 「发过的图」**落盘 + 带时间窗**（2026-10-09 用户要求：「短时间内不要重复」）。
 *
 * 为什么原来的不够：`refs.sentKeys` 是**会话级**的（只记最近 80 个、重启就没），
 * 所以"换个会话再问同一句"照样会把同一张图再贴一遍。
 * 这里给一份**跨会话**的记录：`{ 身份键: 发送时间 }`，窗口内（默认 24 小时）不再发。
 */
export function readSentImages(file) {
  try {
    if (!existsSync(file)) return {};
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** 窗口内发过的身份键集合。 */
export function recentSentKeys(file, { windowMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  const all = readSentImages(file);
  const keys = new Set();
  for (const [k, at] of Object.entries(all)) {
    if (now - Number(at ?? 0) <= windowMs) keys.add(k);
  }
  return keys;
}

/** 记下"这几张发出去了"（只保留窗口内的 + 本次的，文件不会无限长）。 */
export function rememberSentImages(file, keys, { windowMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  const all = readSentImages(file);
  const kept = {};
  for (const [k, at] of Object.entries(all)) {
    if (now - Number(at ?? 0) <= windowMs) kept[k] = at;
  }
  for (const k of keys ?? []) if (k) kept[k] = now;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(kept)}\n`, 'utf8');
    return Object.keys(kept).length;
  } catch {
    return 0;
  }
}

/**
 * 从候选里挑出**没发过的**图，并真的下载下来。
 *
 * `seen` 会被**就地扩充**（同一次收集里也不许重复），调用方据此知道"这一轮碰过哪些图"；
 * 但要注意：它只保证"不再挑同一张"，**是否真的发出去由调用方决定**。
 *
 * @param {Array<{url:string,page?:string}>} items 候选（按搜索排名）
 * @param {{seen?:Set<string>, want?:number, batchSize?:number, maxTry?:number,
 *          fetchBytes?:Function}} [opts]
 * @returns {Promise<{got:Array<{url:string,page:string,sha:string,buf:Buffer,keys:string[]}>,
 *   alreadySeen:number, failed:number, tried:number, remaining:number}>}
 */
export async function collectFreshImages(items, opts = {}) {
  const {
    seen = new Set(),
    want = 2,
    batchSize = 4,
    maxTry = 8,
    fetchBytes = fetchImageBytes,
  } = opts;
  const queue = Array.isArray(items) ? items : [];
  const got = [];
  let alreadySeen = 0;
  let failed = 0;
  let tried = 0;

  for (let i = 0; i < queue.length && got.length < want && tried < maxTry; i += batchSize) {
    const pending = [];
    for (const it of queue.slice(i, i + batchSize)) {
      // 地址级先挡掉：省一次白下载（内容级判据在下载完之后）
      if (isSeenImage([imageUrlKey(it?.url)], seen)) {
        alreadySeen += 1;
        continue;
      }
      pending.push(it);
    }
    tried += pending.length;
    const res = await Promise.all(
      pending.map(async (it) => {
        try {
          return { it, buf: await fetchBytes(it.url, { referer: it.page ?? '' }) };
        } catch (err) {
          return { it, err };
        }
      }),
    );
    for (const r of res) {
      if (got.length >= want) break;
      if (r.err) {
        failed += 1;
        continue;
      }
      const sha = sha256Hex(r.buf);
      const shaKey = imageShaKey(sha);
      if (isSeenImage([shaKey], seen)) {
        // 地址没重但**内容重了**：换个图床的同一张图
        alreadySeen += 1;
        continue;
      }
      const urlKey = imageUrlKey(r.it.url);
      if (urlKey) seen.add(urlKey);
      seen.add(shaKey);
      got.push({
        url: r.it.url,
        page: r.it.page ?? '',
        /**
         * ⚠️ **2026-10-10 补**：原来这里只带 url/page/sha/buf/keys，把候选**自带的标签与分级**丢了 ——
         * 于是「发前筛图」那道闸拿不到 "这作品是 R-18 / 标签是胡桃" 这类事实，
         * 日志里的 `标签=…` 也**从来没打出来过**（用户报的"筛图不给理由"就是在这条链上没法复盘）。
         * 只加两个定义良好的字段（拿不到就是 `[]` / `0`），不改其它调用方的语义。
         */
        tags: Array.isArray(r.it.tags) ? r.it.tags.slice(0, 10) : [],
        xRestrict: Number(r.it.xRestrict ?? 0),
        sha,
        buf: r.buf,
        keys: [urlKey, shaKey].filter(Boolean),
      });
    }
  }

  return { got, alreadySeen, failed, tried, remaining: Math.max(0, queue.length - tried) };
}

/**
 * 网图放行闸。
 *
 * 抽成纯函数是为了**能测**：这段逻辑一开始写死在 bot.mjs 里，
 * 「只私聊发」那条规则只有在真实群聊里才会触发，自测完全覆盖不到——
 * 结果就真踩了：群里用户要图，机器人回「给你找了四张：」，
 * 四张全被闸门拦掉，日志里只有一行 warn。
 *
 * 现在的闸门（与"要不要防色图"无关，纯粹是卫生问题）：
 *   ① 一次最多 `max` 张，防刷屏；
 *   ② 必须是**本次搜索结果里出现过的**地址——模型自己编的不认；
 *   ③ 目标主机不能是内网——NapCat 会去下载这个 URL，等于让模型指挥本机发请求。
 *
 * @param {object} [opts]
 * @param {(url:string)=>boolean} [opts.isAllowed] 白名单判定（默认"本次搜到过"）
 * @param {(host:string)=>boolean} [opts.isForbiddenHost] 主机黑名单（默认内网拦截）
 */
export function createWebImageGate({
  max = 4,
  isAllowed = isSearchedImageUrl,
  isForbiddenHost = isBlockedHost,
} = {}) {
  const cap = Math.max(0, Number(max) || 0);
  let used = 0;
  return function allow(url) {
    if (used >= cap) return false;
    let host;
    try {
      host = new URL(String(url)).hostname;
    } catch {
      return false;
    }
    if (isForbiddenHost(host)) return false;
    if (!isAllowed(String(url))) return false;
    used += 1;
    return true;
  };
}

/** 从 Bing 的图片/视频结果页里抽条目。同一个 `m="{...}"` 属性两边都用。 */
export function parseBingMedia(html, max = 4) {
  const out = [];
  const seen = new Set();
  for (const m of String(html ?? '').matchAll(/m="([^"]*murl[^"]*)"/g)) {
    if (out.length >= max) break;
    let j;
    try {
      j = JSON.parse(m[1].replace(/&quot;/g, '"'));
    } catch {
      continue;
    }
    const u = j?.murl;
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) continue;
    seen.add(u);
    const page = /^https?:\/\//i.test(j?.purl ?? '') ? j.purl : '';
    // 视频结果的标题在 `vt`，图片有时在 `t`——两个都试
    const rawTitle = j?.vt ?? j?.t ?? '';
    const title = decodeEntities(stripHtml(String(rawTitle))).slice(0, 100);
    const duration = /^\d{1,2}:\d{2}(:\d{2})?$/.test(j?.du ?? '') ? j.du : '';
    out.push({ url: u, page, title, duration });
  }
  return out;
}

/**
 * 拼 Bing 的 URL。
 *
 * `extra` 里放额外参数（**不带开头的 `&`**）。之前踩过一次：
 * 调用方把 `adlt=strict&` 塞进 path，结果拼出 `...?adlt=strict&?q=xxx`——
 * 多了一个 `&?`，Bing 直接把查询词丢了，返回它的默认图库，
 * 而我当时只看了 retcode=0 就以为成功。
 */
async function bingHtml(path, query, extra = '') {
  const qs = new URLSearchParams({ q: String(query) });
  for (const [k, v] of new URLSearchParams(extra)) qs.set(k, v);
  const url = `https://cn.bing.com/${path}?${qs.toString()}`;
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 图片搜索。
 *
 * **安全性上只说一句实话**：`adlt=strict` 是尽力而为的过滤，我**没法验证它真的挡住了什么**
 * ——要验证就得拿成人内容去试，那正是我不做的事。所以真正的保护不在这行参数上，
 * 而在别处：只认本次搜出来的地址、只私聊发、一次最多两张。
 */
/** 搜图，只返回候选地址（给代码用：拿到就自己下载，不让模型拼链接）。 */
/**
 * 拼 Bing 图片搜索的地址。**抽成纯函数是为了能测** —— 翻页那件事只有真打网络才知道，
 * 而"用哪个入口"恰恰是实测出来的结论（见下）。
 *
 * ⚠️ 翻页只能走 `/images/async`。2026-10-07 实测（查询词 `可露凯`）：
 *   · `/images/search` **完全无视** `first` / `count`：first=1 / first=100 / count=50
 *     抽回来的前 6 条与不带参数时**100% 相同**；
 *   · `/images/async?...&first=36&mmasync=1` 与首页重叠 **0/6** —— 这才是真翻页。
 * 没有这一步，「再来两张」就只能拿回同一批（这正是用户看到"发的一样"的场景）。
 */
export function bingImageUrl(query, offset = 1) {
  const first = Math.max(1, Math.floor(Number(offset) || 1));
  const qs = new URLSearchParams({ q: String(query) });
  if (first > 1) {
    qs.set('first', String(first));
    qs.set('count', '35');
    qs.set('mmasync', '1');
    qs.set('relp', '35');
    qs.set('adlt', 'strict');
    qs.set('setlang', 'zh-CN');
    return `https://cn.bing.com/images/async?${qs.toString()}`;
  }
  qs.set('adlt', 'strict');
  qs.set('setlang', 'zh-CN');
  return `https://cn.bing.com/images/search?${qs.toString()}`;
}

/**
 * @param {string} query 搜索词
 * @param {number} [count] 要几条候选（1–12）
 * @param {{offset?:number}} [opts] `offset` 是瀑布流的 `first`（第 1 页传 1；翻页按 35 递增）
 */
export async function searchImageUrls(query, count = 4, { offset = 1 } = {}) {
  const n = Math.min(12, Math.max(1, Number(count) || 4));
  const res = await fetch(bingImageUrl(query, offset), {
    headers: { 'user-agent': BROWSER_UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = parseBingMedia(await res.text(), n);
  if (items.length) rememberImageUrls(items.map((i) => i.url));
  return items;
}

/**
 * 把一张网图**真的下载下来**。
 * 为什么要下载：搜到的多半是原站 CDN 地址，带防盗链 —— 直接把它交给 OneBot，
 * NapCat 拉不到、用户点开也是 403/失效（2026-10-07 用户报「给的链接我打不开」）。
 * 带上 Referer 再拉一次通常就能拿到；拉到就转 base64 发出去，之后跟外站没关系了。
 */
export async function fetchImageBytes(url, { referer = '', timeoutMs = 8000, maxBytes = 4 * 1024 * 1024 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'user-agent': BROWSER_UA };
    // ⚠️ Referer 里**经常带中文**（百度百科的地址就是 …/item/砂狼白子/62839164），
    // 而 fetch 的 header 值必须是 ByteString —— 直接塞会抛「Cannot convert argument to a ByteString」，
    // 实测 4 个候选里挂了 1 个，而且报错信息完全看不出是 referer 的锅。encodeURI 一下即可。
    if (referer) headers.referer = encodeURI(String(referer));
    // ⚠️ URL 里可能有中文/空格（百度图床就有）：Node 的 fetch 会直接抛 ByteString 错，
    // 先用 URL 解析器规范化（它会自动百分号编码）。实测 4 个候选里有 1 个栽在这。
    let target = url;
    try {
      target = new URL(url).href;
    } catch {
      /* 不是合法 URL 就原样试 */
    }
    const res = await fetch(target, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') ?? '');
    if (type && !/^image\//i.test(type)) throw new Error(`不是图片（${type}）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('空文件');
    if (buf.length > maxBytes) throw new Error(`太大（${Math.round(buf.length / 1024)}KB）`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * **查歌词 / 接歌**（2026-10-11 用户要「能不能让他能读歌词跟我接歌啊」）。
 *
 * 为什么做成工具、而不是让她"背"：日志里唯一一条歌词记录是她在**凭记忆背**
 * （`听过呀，就是那首《Paris》嘛，歌词是「If we go…」`）—— 模型背歌词会记串、漏段、编词。
 * 接歌游戏里错一句整轮就废，所以：**搜真歌词 → 用代码定位他唱的那句 → 给下一句**。
 *
 * 三种用法（`action`）：
 *   · `search`：只搜歌，给候选（用于"你说的是哪个版本"）
 *   · `get`：取歌词文本（前 60 句，≤1200 字）——用于"这首歌歌词是什么/教我怎么唱"
 *   · `next`：**接歌**。`line` 填**他刚唱的那句**，回**下一句**（唱错几个字也能对上）；
 *     对不上就如实说"这句我没在歌词里找到"，**绝不许自己编一句接上**。
 */
/**
 * **接歌该不该先按歌词识别？**（2026-10-13 抽出纯函数，便于离线自测）
 *
 * 判据：`action='next'` + **没给歌名** + 有词 ⇒ 他填的 `line` 就是"他唱的那句"，
 * 必须走**歌词检索**（`identifySong`），**不能当歌名去搜** ✗
 * （真事故：`next + line:'故事的小黄花'` 被当歌名搜到翻唱《故事的小黄花》⇒ "拿不到歌词" ✗，
 * 而按歌词检索能认出《晴天》✓）。
 */
export function shouldIdentifyByLyric({ action = '', song = '', line = '' } = {}) {
  const want = String(action ?? '').trim() || (String(line ?? '').trim() ? 'identify' : 'get');
  return want === 'next' && !String(song ?? '').trim() && Boolean(String(line ?? '').trim());
}

export async function lyrics({ song = '', artist = '', line = '', action = '', count = 2 } = {}) {
  const want = String(action ?? '').trim() || (String(line ?? '').trim() ? 'identify' : 'get');
  const rawLine = String(line ?? '').trim();
  /**
   * **反向识别**（用户明确要求：「能我说歌词他知道是什么歌也能接上（接上不强求，想接就接，
   * 但要他知道是什么歌）」）：
   *   ① 没给 `song` → 走**歌词检索接口**（`type=1006`）猜歌，再逐个核对歌词里有没有这句；
   *   ② 给了 `song`（模型自己猜的）→ **核对**它；猜错会返回"没认出来"，**不许硬认**。
   * 认得出来就**顺手给下一句**（想接就接）。
   */
  if (want === 'identify') {
    if (!rawLine) return '把他说/唱的那句歌词给我（我按歌词去找是哪首歌）。';
    let hit = null;
    try {
      hit = await identifySong(rawLine, { song, artist });
    } catch (err) {
      return `查歌词出错（${err.message}）——如实说"我这边查不了"，别猜歌名。`;
    }
    if (!hit) {
      const guess = String(song ?? '').trim();
      return (
        `**没认出来**这句歌词${guess ? `（我拿《${guess}》核对过，里面没有这句）` : ''}：` +
        `「${rawLine.slice(0, 40)}」\n—— 如实告诉他"这句我没听出来是哪首歌"，` +
        `**绝不许编一个歌名**；可以请他再说两句、或者直接说歌名。`
      );
    }
    return (
      `**认出来了**：《${hit.song}》- ${hit.artists}` +
      `${hit.cover ? '（⚠️ 这个版本是**翻唱/改编**，原唱可能另有其人 —— 歌名是对的，艺人别说得太肯定）' : ''}` +
      `\n他唱的是第 ${hit.index + 1} 句「${hit.matched}」（${hit.via === 'guess' ? '拿你猜的歌名核对通过' : '按歌词检索找到'}）\n` +
      `**下一句**：${hit.next.join(' ／ ')}\n` +
      `（接不接随你：想接就**只唱词、别解释**；不想接就说出歌名和歌手，别编歌词。）`
    );
  }
  const q = String(song ?? '').trim() || rawLine;
  if (!q) return '要查哪首歌？（给我歌名，或者直接把歌词那句唱给我，我去对）';
  /**
   * ⚠️ **接歌的主路径修好了**（2026-10-13，用真模型端到端测出来的真 bug）：
   *
   * 模型接歌时**不给歌名**、只填 `line`（那正是"他唱的那句"），例如
   * `lyrics({action:'next', line:'故事的小黄花'})`。而旧代码在 `next` 分支里
   * **把这句歌词当歌名去搜**（`searchSongs('故事的小黄花')`）✗ ⇒ 搜到一首**翻唱正好叫这名字**
   * （《故事的小黄花》- 苏子墨）⇒ 那首拿不到歌词 ⇒ 工具回"这首歌我这儿没有歌词" ✗✗
   * （而按歌词检索**明明能认出是《晴天》** ✓ —— `searchByLyric('故事的小黄花')` 实测 top1 = 晴天/周杰伦 ✓）。
   *
   * 所以：**`next` + 没给歌名 + 有词** ⇒ 先走**歌词识别**（`identifySong` 会核对歌词里到底有没有这句 ✓），
   * 认出来就直接用它的「下一句」（那是验证过的 ✓）。认不出来再退回按歌名搜的老路 ✓。
   */
  if (shouldIdentifyByLyric({ action: want, song, line: rawLine })) {
    let hit = null;
    try {
      hit = await identifySong(rawLine, {});
    } catch {
      hit = null; // 查歌词出错就走老路（下面按歌名搜），别把整轮弄崩
    }
    if (hit) {
      return (
        `**认出来了**：《${hit.song}》- ${hit.artists}` +
        `${hit.cover ? '（⚠️ 版本是**翻唱/改编**，歌名对、艺人别说得太肯定）' : ''}` +
        `\n他唱的是第 ${hit.index + 1} 句「${hit.matched}」（按歌词检索找到，相似度 ${hit.score}）\n` +
        `**下一句**：${hit.next.join(' ／ ')}\n` +
        `（接歌时**只唱词**，别解释、别加旁白；想接着往下就再调一次，line 填这一句。）`
      );
    }
  }
  const songs = await searchSongs(q, { limit: 5 });
  if (!songs.length) return `没搜到「${q}」这首歌（换个说法：歌名 + 歌手）——**别自己编歌词**。`;
  // 有 artist 就优先挑那个版本
  const a = String(artist ?? '').trim();
  const picked = (a && songs.find((s) => s.artists.includes(a))) || songs[0];
  if (want === 'search') {
    return `搜到 ${songs.length} 个版本：\n${songs.map((s, i) => `${i + 1}. 《${s.name}》- ${s.artists}（id ${s.id}${s.durationSec ? `，${Math.floor(s.durationSec / 60)}:${String(s.durationSec % 60).padStart(2, '0')}` : ''}）`).join('\n')}\n要哪个？说歌手名我再取。`;
  }
  const L = await fetchLyrics(picked);
  if (!L.lines.length) {
    return (
      `《${picked.name}》- ${picked.artists} 这首歌**拿不到歌词**` +
      `（常见原因：版权受限、只有纯音乐、或者网易云给的是残缺的翻唱版本）——` +
      `**如实说"这首歌我这儿没有歌词"，别用记忆硬背**。`
    );
  }
  if (want === 'next') {
    const r = pickNextLines(L.lines, rawLine, { count });
    if (!r) {
      return (
        `《${picked.name}》- ${picked.artists} 的歌词里**没找到**「${rawLine.slice(0, 30)}」这句` +
        `（可能你记混了、或者不是我拿到的这个版本）。开头几句是：${L.lines.slice(0, 3).join(' ／ ')}` +
        `\n——如实跟他说"这句歌词里没有"，**别硬接**。`
      );
    }
    return (
      `《${picked.name}》- ${picked.artists}：他唱的是第 ${r.index + 1} 句「${r.matched}」（对得上，相似度 ${r.score}）。\n` +
      `**下一句**：${r.next.join(' ／ ')}\n` +
      `（接歌时**只唱词**，别解释、别加"这句是…"这种旁白；想接着往下就再调一次，line 填这一句。）`
    );
  }
  return (
    `${lyricsForModel({ title: picked.name, artists: picked.artists, lines: L.lines })}\n` +
    `（共 ${L.lines.length} 句能唱的行；要**接歌**就把 action 设成 next、line 填他唱的那句。）`
  );
}

/**
 * **查聊天记录**（2026-10-11 用户要的「7 天聊天记录作为完整记忆」＋「按时间找」）。
 *
 * 两种用法：
 *   · **按时间**：`when` 直接写用户说的那个时间词（`"今早"`/`"昨晚"`/`"昨天下午"`/`"前天"`/
 *     `"刚才"`/`"10月9日"`/`"最近 3 天"`）—— 代码解析成**具体时间段**，只读那几天/那几个小时的档
 *     （目录结构就是按天 + 小时分的，所以很快）。这种模式**可以不给关键词**（"昨晚聊了啥"）。
 *   · **按关键词**：`query`，默认在最近 7 天里找。
 * 两者都给就先按时间窗口、再按关键词过滤。
 *
 * 省 token 的设计没变：**不调用就不花任何 token**；回的是命中的原话（带时间与说话人），总量 ≤2400 字。
 */
export async function recallChat({ query = '', days = 7, when = '', limit = 10, scope = '', mode = '', send = false } = {}, ctx = null) {
  const a = ctx?.chatArchive;
  if (!a?.search) return '（聊天归档没启用，翻不了旧记录）';
  const q = String(query ?? '').trim();
  const w = String(when ?? '').trim();
  const modeStr = String(mode ?? '').trim();
  if (!q && !w && modeStr !== 'summary') return '要查什么？给个关键词，或者给个时间（比如"今早""昨晚""昨天下午"）。';
  let win = null;
  if (w) {
    try {
      win = parseTimeWindow(w, { now: Date.now(), recallDays: a.recallDays ?? a.ttlDays ?? 7 });
    } catch {
      win = null;
    }
    if (!win) return `没看懂这个时间「${w}」——换个说法（今早 / 昨晚 / 昨天 / 前天 / 刚才 / 10月9日 / 最近 3 天）。`;
  }
  const n = Math.min(20, Math.max(1, Number(limit) || 10));
  const where = win ? win.label : `最近 ${Math.min(90, Math.max(1, Number(days) || 7))} 天`;

  /**
   * **大跨度先给摘要**（用户问的「跨度大且分散怎么办」）：
   *   · `mode='summary'` 强制只要摘要；
   *   · 时间跨度 > 1 天且没给关键词时**自动**走摘要（否则一次最多 20 条，看不到全貌）。
   * 摘要就是每个小时档一行（时间、条数、谁说的、代表句），她一眼能看懂，要细节再说一声。
   */
  const spanDays = win ? Math.round((win.to - win.from) / 86400000) : 0;
  const wantSummary = modeStr === 'summary' || (!q && (spanDays >= 1 || (!win && (Number(days) || 7) > 2)));
  if (wantSummary && typeof a.summaries === 'function') {
    let list = [];
    try {
      list = a.summaries({ from: win?.from ?? 0, to: win?.to ?? 0, days: Math.min(90, Math.max(1, Number(days) || 7)) });
    } catch (err) {
      return `翻摘要失败：${err.message}`;
    }
    if (!list.length) {
      if (win?.outside) return `${win.label} 那会儿的记录**归档里没有**（${a.ttlDays > 0 ? `只保留最近 ${a.ttlDays} 天` : '归档是永久保留的，所以那会儿大概真没聊过'}）。别编内容。`;
      return `${where} 里没有记录。`;
    }
    const lines = list.slice(0, 30).map((s) => {
      const d = new Date(s.at);
      const p = (x) => String(x).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}点：${s.summary}`;
    });
    const more = list.length > 30 ? `\n（还有 ${list.length - 30} 个小时没列，范围说小一点我就接着给）` : '';
    return (
      `【${where}·每小时摘要】共 ${list.length} 个时段：\n${lines.join('\n')}${more}\n` +
      `（要哪个时段的具体原话，用 when 指定那个时间再查一次；要看当时的图/视频就把 send 设成 true）`
    ).slice(0, 2400);
  }

  let rows = [];
  try {
    rows = a.search({
      query: q,
      days: Math.min(90, Math.max(1, Number(days) || 7)),
      limit: n,
      key: String(scope ?? ''),
      from: win?.from ?? 0,
      to: win?.to ?? 0,
    });
  } catch (err) {
    return `翻聊天记录失败：${err.message}`;
  }
  const fmt = (ts) => {
    const d = new Date(Number(ts) || 0);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const clip = (s, n2) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n2 ? `${t.slice(0, n2)}…` : t;
  };
  if (!rows.length) {
    // ⚠️ 两种"没找到"要分开说：**归档里确实没有** vs **那会儿早于保留范围**（后者要如实说没留着，别装作查过）
    if (win?.outside) {
      return `${win.label} 那会儿的记录**归档里没有**（${a.ttlDays > 0 ? `只保留最近 ${a.ttlDays} 天` : '归档是永久保留的，所以那会儿大概真没聊过'}）。别编内容。`;
    }
    return `${where} 里没有${q ? `和「${q}」相关的` : ''}记录。`;
  }
  // 命中里有图/视频且她要 send → **直接把当时的图/视频发出来**（"图片视频也要能找"）
  let sent = 0;
  if (send) {
    for (const r of rows) {
      for (const m of r.media ?? []) {
        if (!m?.file) continue;
        try {
          if (m.kind === 'video') {
            // 视频当**文件**发（QQ 里点开就能看），走 OneBot 的 upload_file
            // eslint-disable-next-line no-await-in-loop
            const up = await ctx?.onebot?.uploadFile?.(ctx?.target ?? {}, { file: m.file, name: m.file.split(/[\\/]/).pop() || 'video.mp4' });
            if (up?.ok) sent += 1;
          } else {
            // eslint-disable-next-line no-await-in-loop
            const ok = await ctx?.sendImage?.(m.file, {});
            if (ok !== false) sent += 1;
          }
        } catch {
          /* 单张发失败不影响回话 */
        }
      }
    }
  }
  const lines = rows.map((r) => `${fmt(r.at)} ${r.who || '某人'}：${clip(r.text, 120)}${r.hasImage ? '（带图）' : ''}`);
  const tail = sent ? `\n（另外把命中的 ${sent} 个图/视频发出去了）` : send ? '\n（这些记录里没有可发的图/视频）' : '';
  return `【${where}】共 ${rows.length} 条：\n${lines.join('\n')}${tail}`.slice(0, 2400);
}

export async function searchImages({ query, count = 3 }, ctx = null) {
  const n = Math.min(4, Math.max(1, Number(count) || 3));
  /**
   * ⚠️ 2026-10-10：**优先走"直接发图"那条链**（bot.mjs 把 findImages 注入进来）。
   * 它自己会做：pixiv 优先 → 下载 → 发前筛图 → 真发出去 → 报出处。
   * 拿不到那个能力（比如单测/别的调用方）才退回原来的"只回链接"老行为。
   */
  if (ctx && typeof ctx.findImages === "function") {
    try {
      const out = await ctx.findImages(String(query ?? "").trim(), { count: n });
      return String(out ?? "").trim() || "搜了，但没拿到能发出去的图。";
    } catch (err) {
      return `找图失败：${err.message}`;
    }
  }
  try {
    const items = parseBingMedia(await bingHtml('images/search', query, 'adlt=strict&setlang=zh-CN'), n);
    if (!items.length) return `没搜到「${query}」的图片。`;
    rememberImageUrls(items.map((i) => i.url));
    return (
      items.map((it, i) => `${i + 1}. ${it.url}${it.page ? `\n   来源页：${it.page}` : ''}`).join('\n') +
      '\n\n（要把某张发给主人，就用 [[网图:上面那条完整地址]]；只私聊时能发，群里会换成链接。）'
    );
  } catch (err) {
    return `图片搜索失败：${err.message}`;
  }
}

/**
 * 视频搜索：**故意不返回抓取到的视频条目**。
 *
 * 实测（2026-10-06）Bing 的视频结果页抓下来是**完全不相关**的内容：
 * 搜「黑神话悟空 广智 打法」返回 40 条，全是开普敦旅游和闲鱼推广，
 * 一条关于游戏的都没有。页面标题确认 Bing 收到了查询词，但结果列表是另一套
 * （可能是没有 cookie 时它给的是轮播内容）。
 *
 * 把这种东西交给模型，它会理直气壮地转达一堆无关视频——**比没有更糟**。
 * 所以这里只给搜索页链接，让用户自己点进去看真正的结果。
 */
async function searchVideos({ query, keyword }) {
  const q = String(keyword || query || '').trim();
  if (!q) return '没给搜索词。';
  const enc = encodeURIComponent(q);
  return (
    `我没法直接给你视频列表（见下），但这几个搜索页里就是你要的：\n` +
    `· B站：https://search.bilibili.com/all?keyword=${enc}\n` +
    `· Bing 视频：https://cn.bing.com/videos/search?q=${enc}\n` +
    `· 抖音：https://www.douyin.com/search/${enc}\n\n` +
    `（说明：视频结果的抓取实测不可用——搜「黑神话悟空 广智打法」抓回来的是开普敦旅游和闲鱼推广。` +
    `与其给你一堆不相关的视频，不如把搜索页给你。如果用户要的是"某个视频讲了什么"，可以先用 web_search 找文字攻略。）`
  );
}

const WEATHER_TIMEOUT_MS = 12000;
const NET_TIMEOUT_MS = 15000;
/** 装成普通浏览器：Bing 对默认 UA 会返回降级页面。 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 常见命名实体。网页里真正高频的就这些，其余按空格处理。 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•',
  times: '×', divide: '÷', deg: '°', laquo: '«', raquo: '»',
};

function codePointOrEmpty(n) {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return '';
  if (n < 0x20 && n !== 9 && n !== 10) return ''; // 控制字符丢掉
  return String.fromCodePoint(n);
}

/** 解 HTML 实体。数字实体（十进制/十六进制）都要认，否则会漏出 `&#0183;` 这种东西。 */
export function decodeEntities(input) {
  return String(input ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePointOrEmpty(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePointOrEmpty(Number(d)))
    .replace(/&([a-z][a-z0-9]*);/gi, (_, name) => NAMED_ENTITIES[name.toLowerCase()] ?? ' ');
}

/** 去标签 + 解实体 + 压空白。够用的 HTML → 纯文本。 */
export function stripHtml(input) {
  return decodeEntities(
    String(input ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从 Bing 结果页里抽条目。
 * 抽成纯函数是为了能拿一段固定 HTML 做断言——不然"搜索结果对不对"
 * 只能靠真去搜一次，而且搜出来的东西每天都不一样。
 */
export function parseBingResults(html, max = 6) {
  const chunks = String(html ?? '').split(/<li class="b_algo"/).slice(1);
  const out = [];
  for (const c of chunks) {
    if (out.length >= max) break;
    const link = c.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const href = link[1];
    if (!/^https?:/i.test(href)) continue;
    const snip = c.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const title = stripHtml(link[2]).slice(0, 120);
    if (!title) continue;
    out.push({ title, url: href, snippet: snip ? stripHtml(snip[1]).slice(0, 240) : '' });
  }
  return out;
}

/** 本机/内网地址一律不抓——模型给的 URL 不能变成打自己家内网的跳板。 */
export function isBlockedHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0' || h === '::') return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224) return true;
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // IPv6 ULA
  return false;
}

async function searchWeb({ query, count = 6 }) {
  const n = Math.min(10, Math.max(1, Number(count) || 6));
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(String(query))}`;
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  if (!res.ok) return `搜索失败：HTTP ${res.status}`;
  const items = parseBingResults(await res.text(), n);
  if (!items.length) return `没搜到「${query}」的结果，换个说法试试。`;
  return items
    .map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet}`)
    .join('\n');
}

async function fetchPage({ url }) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return `这个链接不合法：${url}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只支持 http/https 链接。';
  if (u.port && u.port !== '80' && u.port !== '443') return '只允许 80 / 443 端口。';
  if (isBlockedHost(u.hostname)) return '本机 / 内网地址不抓。';

  // 域名解析出来再查一次：否则 foo.com 解析到 127.0.0.1 就绕过了上面那层
  try {
    const { address } = await lookup(u.hostname);
    if (isBlockedHost(address)) return '这个域名指向内网地址，不抓。';
  } catch {
    return `域名解析不了：${u.hostname}`;
  }

  const res = await fetch(u, {
    headers: { 'user-agent': BROWSER_UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) return `打不开这个页面：HTTP ${res.status}`;
  const ct = res.headers.get('content-type') ?? '';
  if (!/text|html|json|xml/i.test(ct)) return `这不是网页内容（${ct || '未知类型'}），不读。`;

  const buf = Buffer.from(await res.arrayBuffer());
  const plain = stripHtml(buf.subarray(0, 300 * 1024).toString('utf8'));
  if (!plain) return '页面里没抽到文字（可能是纯 JS 渲染的）。';
  return plain.slice(0, 4000) + (plain.length > 4000 ? '\n…（后面还有内容，已截断）' : '');
}

/** WMO 天气代码 → 中文。模型看不懂 0/61/95，得翻译。 */
const WMO = {
  0: '晴',
  1: '少云',
  2: '局部多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '毛毛雨',
  53: '小雨',
  55: '中雨',
  56: '冻毛毛雨',
  57: '冻雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '强阵雨',
  82: '暴雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨夹冰雹',
  99: '强雷阵雨夹冰雹',
};

export function describeWeatherCode(code) {
  return WMO[code] ?? `未知天气(${code})`;
}

/** 给模型看的工具声明（OpenAI / DeepSeek 的 function calling 格式）。 */
export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'lyrics',
      description:
        '**查真实歌词 / 接歌**（网易云）。' +
        '⚠️ **别凭记忆背歌词**（会记串、漏段、编词）——只要涉及歌词就调这个。' +
        '三种用法：`action:"next"` **接歌**（`line` 填**他刚唱的那句**，回下一句；唱错几个字也能对上，对不上会明确告诉你"歌词里没有"——那就如实说，**绝不自己编一句接上**）；' +
        '`action:"get"` 取整首歌词文本（用于"这歌歌词是什么/教我唱"）；`action:"search"` 只给候选版本（他说的版本不确定时用）。' +
        '接歌时**只唱词、别解释**，不要加"这句的意思是…"这种旁白。',
      parameters: {
        type: 'object',
        properties: {
          song: { type: 'string', description: '歌名（接歌时可以不填，直接从 line 里认）' },
          artist: { type: 'string', description: '歌手名，用于在同名歌曲里挑对版本' },
          line: { type: 'string', description: '他刚唱的那句歌词（`action:"next"` 时填这个）' },
          action: { type: 'string', enum: ['search', 'get', 'next'], description: 'next=接歌（默认，给了 line 时）；get=取歌词；search=只搜版本' },
          count: { type: 'integer', description: '接几句，默认 2（最多 6）', minimum: 1, maximum: 6 },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description:
        '查某个城市的实时天气与未来几天预报。用户问天气、气温、下不下雨、要不要带伞时用它。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名，中文或英文都行，例如「北京」「上海」「Tokyo」' },
          days: { type: 'integer', description: '要看几天的预报，1-3，默认 1', minimum: 1, maximum: 3 },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索。用户问游戏攻略、新闻、最新消息、或者你不确定的事实时用它。返回若干条标题 + 链接 + 摘要。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词。用关键词组合，别把整句话塞进去' },
          count: { type: 'integer', description: '要几条结果，1-10，默认 6', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description:
        '打开一个网页读它的正文。当搜索结果的摘要不够（比如你要讲清楚某个攻略步骤）时，用它深入读某一页。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整网址，http 或 https' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_chat',
      description:
        '翻**最近几天的聊天原文**（本地归档，含群聊/私聊、图片与引用）。' +
        '只在用户问起过去的事时用。**按时间找**就用 `when` 填用户说的那个时间词（今早/昨晚/昨天下午/前天/刚才/10月9日/最近 3 天）——' +
        '代码会去对应的日期文件夹与小时档里找（“今早”就只翻今早那个时段）；' +
        '**纯问某个时段聊了啥时可以只给 `when`、不给 `query`**。' +
        '**不调用它就不花任何 token**；调用后只返回命中的原话（带时间与说话人）。' +
        '⚠️ 查不到就如实说没找到，**别编**。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词：人名、物件、那句话里的词都行（按时间浏览时可省略）' },
          when: {
            type: 'string',
            description: '时间词，原样填用户说的：今早 / 今天上午 / 昨晚 / 昨天晚上 / 昨天 / 昨天下午 / 前天 / 大前天 / 刚才 / 今天 / 这几天 / 最近 3 天 / 10月9日 / 2026.10.09',
          },
          mode: {
            type: 'string',
            description: '填 "summary" 时只回**每小时摘要**（跨度大、想先看全貌时用；时间跨度≥1 天且没给关键词时也会自动走这个）',
            enum: ['summary'],
          },
          send: {
            type: 'boolean',
            description: 'true = 把命中的图片/视频**直接发出来**（她说"把那天那张图发我"时用）',
          },
          days: { type: 'integer', description: '没给 when 时往前查几天，默认 7（最多 90）', minimum: 1, maximum: 90 },
          limit: { type: 'integer', description: '最多回几条，默认 10（最多 20）', minimum: 1, maximum: 20 },
          scope: {
            type: 'string',
            description: '限定某个会话，格式 group:<群号> 或 private:<QQ号>；不填就是所有会话',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_images',
      description:
        '搜图片并发出去。用户要壁纸、要某样东西的图时用它。' +
        '它**会直接把图发出去**（优先 pixiv，拿不到再退回网页搜索），' +
        '返回的是「已发出 N 张 + 作者/作品号」这样的结果，照着转达即可 —— ' +
        '不用再自己拼链接、也不用写 [[网图:…]] 标记。' +
        '（没配代理时 pixiv 不可用，会自动走网页搜索。）',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜什么图，用关键词' },
          count: { type: 'integer', description: '要几张，1-4，默认 3', minimum: 1, maximum: 4 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_videos',
      description:
        '当用户想找视频时用。返回几个视频搜索页的链接（B站 / Bing / 抖音），让用户自己点进去看。' +
        '注意：**它不会返回具体视频**，因为抓取到的视频列表实测不可用（结果与查询无关）。' +
        '要回答"某个视频讲了什么"，改用 web_search 找文字内容。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '要搜的关键词' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bilibili_search',
      description:
        '去 B站搜视频。**查梗首选它**：搜「XXX 是什么梗」通常能直接搜到「网梗指南」「梗百科」这类专门讲梗的 UP 主，标题本身就把答案说了一半。' +
        '**搜索词要用梗的原词，别用自己的转述**——实测搜「电击萝莉控 是什么梗」两次都精准命中，' +
        '而搜转述过的「电一电 是什么梗」连搜三次给了三个不同结果。B站结果本身会波动。' +
        '也可用于查游戏攻略、教程、评测。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索词，例如「电一电 是什么梗」' },
          count: { type: 'integer', description: '要几条，1-10，默认 6', minimum: 1, maximum: 10 },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bilibili_hot',
      description: '看 B站现在在热什么（热搜词 + 热门视频）。用户问「最近有什么梗」「最近什么火」时用它。',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'integer', description: '各要几条，1-20，默认 8', minimum: 1, maximum: 20 },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bilibili_video',
      description:
        '打开一个 B站视频。**用户发来 B站链接、或让你看「这个视频讲了什么」时，就用它。**' +
        '能得到：标题、UP、播放量、简介、观众弹幕，**以及视频里说的话的字幕原文**' +
        '（字幕需要登录 B站；没登录时只有文字层，那种情况下**绝不要猜视频内容**）。' +
        '链接**原样粘进来就行**，BV 号 / b23.tv 短链 / av 号都认。',
      parameters: {
        type: 'object',
        properties: {
          bvid: {
            type: 'string',
            description:
              'BV 号、完整视频网址、b23.tv 短链、或 av 号都可以。' +
              '**直接把用户发给你的那个链接原样粘进来就行**，不要自己转换或截断。',
          },
          danmakuCount: { type: 'integer', description: '要几条弹幕，5-40，默认 25', minimum: 5, maximum: 40 },
        },
        required: ['bvid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: '查当前的日期和时间。用户问「现在几点」「今天几号」「星期几」时用它。',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA 时区名，例如 Asia/Shanghai，默认就是它' },
        },
        required: [],
      },
    },
  },
];

async function getJson(url, timeoutMs = WEATHER_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'qq-bot/0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function getWeather({ city, days = 1 }) {
  return (async () => {
    const n = Math.min(3, Math.max(1, Number(days) || 1));
    const geo = await getJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(String(city))}&count=1&language=zh&format=json`,
    );
    const hit = geo?.results?.[0];
    if (!hit) return `没有找到叫「${city}」的地方。换个说法试试（比如带上省份或者用英文名）。`;

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=auto&forecast_days=${n}`;
    const w = await getJson(url);
    const cur = w?.current;
    const d = w?.daily;
    if (!cur || !d) return `拿到了「${hit.name}」的位置，但天气数据没取到。`;

    const where = [hit.country, hit.admin1, hit.name].filter(Boolean).join(' · ');
    const lines = [
      `${where} 当前：${describeWeatherCode(cur.weather_code)}，${cur.temperature_2m}°C（体感 ${cur.apparent_temperature}°C），` +
        `湿度 ${cur.relative_humidity_2m}%，风速 ${cur.wind_speed_10m} km/h。`,
    ];
    for (let i = 0; i < d.time.length; i += 1) {
      const label = i === 0 ? '今天' : i === 1 ? '明天' : '后天';
      const rain = d.precipitation_probability_max?.[i];
      lines.push(
        `${label}（${d.time[i]}）：${describeWeatherCode(d.weather_code[i])}，${d.temperature_2m_min[i]}~${d.temperature_2m_max[i]}°C` +
          (rain !== null && rain !== undefined ? `，降水概率 ${rain}%` : ''),
      );
    }
    return lines.join('\n');
  })();
}

function getTime({ timezone = 'Asia/Shanghai' } = {}) {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: String(timezone),
      dateStyle: 'full',
      timeStyle: 'medium',
    });
    return `${fmt.format(now)}（${timezone}）`;
  } catch {
    return `时区「${timezone}」不认。用 IANA 名字，比如 Asia/Shanghai。`;
  }
}

/**
 * 「当前时间」这一行 —— 给模型一个**永远不会错**的时钟。
 *
 * 为什么要主动喂：`get_time` 工具存在，但它**不一定调**。2026-10-07 实测两次：
 * 11:24 那次调了、答对了；16:12 主人问「你看看现在才几点」「今天日期是什么」，
 * 它一次都没调，直接编了个「8 月 20 号」，还自己圆了一句"机器表走偏了"。
 * 上下文里没有时间 → 就只能编（和"没调工具却说设好了"是同一个形状）。
 * 所以时间要**每轮塞进上下文**（放最后一条消息里，见 bot.mjs —— 放那边不破坏前缀缓存）。
 */
export function nowLabel(timezone = 'Asia/Shanghai') {
  return getTime({ timezone });
}

/**
 * **日期锚点**（2026-10-11 加）：除了"现在几点"，再给一张**相对日对照表**。
 *
 * 为什么：用户反馈「他对时间（星期几，昨天这种）好像不是特别敏感」。
 * 查下来我们**每轮都注入了当前时间**（含星期 ✓），但**没给相对日的映射** ——
 * "昨天是几号、前天是周几"要模型**自己算日期**，而日期算术恰恰是它最容易错的地方
 * （bot.mjs 里有实测记录：问"今天日期是什么"它不调工具、直接编了个"8 月 20 号"）。
 * 现在把它算好喂进去：**一行、约 25 token，省掉它所有日期算术**。
 *
 * 形如：`今天=10-11(周日) ｜ 昨天=10-10(周六) ｜ 前天=10-09(周五) ｜ 明天=10-12(周一) ｜ 后天=10-13(周二)`
 */
export function timeAnchor(timezone = 'Asia/Shanghai', now = Date.now()) {
  try {
    const fmt = (d) =>
      new Intl.DateTimeFormat('zh-CN', { timeZone: String(timezone), month: '2-digit', day: '2-digit', weekday: 'short' })
        .format(d)
        .replace(/\//g, '-')
        .replace(/周([一二三四五六日天])/, '($1)');
    const day = 24 * 3600 * 1000;
    return [
      ['今天', 0],
      ['昨天', -1],
      ['前天', -2],
      ['明天', 1],
      ['后天', 2],
    ]
      .map(([name, off]) => `${name}=${fmt(new Date(now + off * day))}`)
      .join(' ｜ ');
  } catch {
    return '';
  }
}

/** 更短的「参考时间」（`2026-10-07 周三 17:26`）—— 给每轮注入用的那个。
 * 为什么短：长的那串又带秒又带时区名，存在感太强，模型会**忍不住把它念出来**
 * （2026-10-07 用户原话：「这怎么又一直揪着时间不放了」）。
 */
export function nowLabelShort(timezone = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: String(timezone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(new Date())
      .replace(/\//g, '-');
  } catch {
    return getTime({ timezone });
  }
}


/**
 * 「看画面」：把 B站 的进度条缩略图网格交给视觉模型，拿回一段画面描述。
 *
 * 为什么 `askWithImage` 用**动态 import**：`llm.mjs` 静态导入了本文件的
 * `TOOL_DEFS` / `execTool`，本文件再静态导入它就成了循环依赖。
 * 动态 import 只在真要用时才加载，绕开这个圈。
 */
async function describeVideoFrames(bvid) {
  const { config } = loadConfig();
  if (config.bilibili?.describeFrames === false) return '';

  const bv = await resolveBvid(bvid);
  if (!bv) return '';

  const v = await (
    await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, {
      headers: { 'user-agent': 'qq-bot/0.1', referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000),
    })
  ).json();
  if (v?.code !== 0) return '';

  const shot = await getVideoShot(bv, v.data.cid);
  if (!shot) return '';

  const { askWithImage } = await import('./llm.mjs');
  const out = await askWithImage(config, {
    prompt:
      `这是一段视频的缩略图网格（${shot.xLen} 列 × ${shot.yLen} 行，从左到右、从上到下按时间顺序，` +
      '相邻两格大约相隔 5 秒）。用中文说这段视频**画面**上是什么样：什么场景、有没有人、' +
      '有没有明显的变化或切换。120 字以内，直接说看到的东西，别说「这是一张图」。',
    imageBase64: shot.base64,
    mime: shot.mime,
    maxTokens: 400,
    temperature: 0.2,
  });
  const text = String(out.text ?? '').trim();
  if (!text) return '';

  // 标明来源：这是**稀疏缩略图**看来的，不是逐帧 —— 别让模型把细节说得太肯定
  const step = Math.max(1, Math.round((v.data.duration || 0) / Math.max(1, shot.times.length)));
  return `\n【画面】由进度条缩略图（约每 ${step} 秒一格）看出，**看不到细节动作**：${text}`;
}

/** `bilibili_video` 的对外实现：文字层 + 字幕 + 画面描述。 */
async function videoInfoWithFrames(args = {}) {
  const base = await videoInfo(args);
  try {
    const extra = await describeVideoFrames(args.bvid ?? '');
    return extra ? `${base}\n${extra}` : base;
  } catch {
    return base; // 画面这一步失败，不该把已经拿到的字幕也弄丢
  }
}

const IMPL = {
  get_weather: getWeather,
  get_time: getTime,
  web_search: searchWeb,
  fetch_page: fetchPage,
  search_images: searchImages,
  search_videos: searchVideos,
  bilibili_search: searchBilibili,
  bilibili_hot: hotBilibili,
  bilibili_video: videoInfoWithFrames,
  recall_chat: recallChat,
  lyrics,
};

/**
 * 执行一次工具调用。
 * **永远返回字符串、永远不抛**——工具挂了不该把整条回复带崩，
 * 把错误原文交给模型，让它自己决定怎么跟用户说。
 *
 * `ctx` 只有**控制类工具**用得上：它们要拿配置和「这条消息是谁发的」去过闸。
 * 控制类**不走 IMPL 表**——那张表是"谁都能调"的只读工具，混在一起早晚出事。
 */
export async function execTool(name, args = {}, ctx = null) {
  if (CONTROL_TOOL_NAMES.has(name)) {
    return runControlTool(ctx?.cfg ?? null, name, args ?? {}, ctx);
  }
  if (REMINDER_TOOL_NAMES.has(name)) {
    return runReminderTool(ctx?.cfg ?? null, name, args ?? {}, ctx);
  }
  if (MEMORY_TOOL_NAMES.has(name)) {
    return runMemoryTool(ctx?.cfg ?? null, name, args ?? {}, ctx);
  }
  if (QQACT_TOOL_NAMES.has(name)) {
    // 「她自己的账号」那套：要 `ctx.onebot` 才能真的调接口（自测里换成替身）
    return runQqActTool(ctx?.cfg ?? null, name, args ?? {}, ctx);
  }
  if (BILIACT_TOOL_NAMES.has(name)) {
    // B站 侧的动作（点赞/投币/收藏/关注）：走 HTTP + csrf（自测注入 biliPost/biliGet/biliView）
    return runBiliActTool(ctx?.cfg ?? null, name, args ?? {}, ctx);
  }
  const impl = IMPL[name];
  if (!impl) return `错误：没有叫 ${name} 的工具。`;
  try {
    /**
     * ⚠️ **2026-10-11 修的真 bug**：这里原来是 `impl(args ?? {})` —— **ctx 被丢掉了**。
     * 而 `search_images` 正是靠 `ctx.findImages` 才会"真的把图发出去"
     * （见 `searchImages()` 里那段判断），拿不到 ctx 就**静默退回"只回链接"的老路径**：
     * 工具描述承诺的是"会直接把图发出去、照着转达即可"，实际却给了模型一串 URL。
     *
     * 证据：`[找图] 工具路径` 这句日志（只在 `ctx.findImages` 那条路里打）
     * 在 `logs/bot-2026-10-*.log` 里**一次都没出现过**，而正则接管那条路跑了 84 次
     * —— 也就是说这条路**从来没跑通过**，且没有任何报错。
     * 现在把 ctx 传下去，并加了自测断言钉住"IMPL 工具必须收到 ctx"。
     */
    return String(await impl(args ?? {}, ctx));
  } catch (err) {
    return `工具 ${name} 执行失败：${err.message}`;
  }
}

export const TOOL_NAMES = Object.keys(IMPL);

/* ================== 手机（ADB 驱动雷电模拟器，2026-10-19 加） ==================
 * 用户：「我想象中就是自己玩游戏可能会叫我一起，她刷 b 站可以控制手机 @ 我」
 * 走 ADB 而不是模拟鼠标：雷电自带 adb.exe，input tap/swipe/text 是确定性的 ✓；
 * exec-out screencap -p 直接给一张 PNG ✓ —— 再喂给视觉模型换成文字 ✓（她就能"看"）。
 *
 * ⚠️ 默认**不启用**（config.phone.enabled）✓；安装/卸载这类写动作**要主人点头** ✓（这里只暴露 install 执行器 ✓）。
 * ⚠️ 从沙箱里 spawn 会被 EPERM 挡 ✓（机器人跑在沙箱外，不受影响 ✓）。
 */
const PHONE_DEFS = [
  {
    type: 'function',
    function: {
      name: 'phone_status',
      description: '看手机在不在线：设备、型号、分辨率、当前前台应用。用之前先问一次这个。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_start',
      description: '把雷电模拟器开起来（没开的时候用）。会等到系统开机完成，通常 30~60 秒。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_look',
      description:
        '看手机现在屏幕上是什么：截一张图，交给识图模型，**返回文字描述**（谁在屏幕上、有什么按钮、现在停在哪）。' +
        '想操作手机之前**必须先看一次**，别盲点。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '你特别想知道什么（可选），比如「现在能不能点播放」' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_tap',
      description: '在手机上点一下（坐标用 phone_look 里描述的位置；分辨率是 phone_status 报的那个）。',
      parameters: {
        type: 'object',
        properties: { x: { type: 'integer' }, y: { type: 'integer' } },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_swipe',
      description: '在手机上滑一下：从 (x1,y1) 滑到 (x2,y2)。刷视频/翻页用。',
      parameters: {
        type: 'object',
        properties: {
          x1: { type: 'integer' }, y1: { type: 'integer' },
          x2: { type: 'integer' }, y2: { type: 'integer' },
          ms: { type: 'integer', description: '滑动时长毫秒，默认 300', minimum: 50, maximum: 2000 },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_key',
      description: '按手机上的键：back / home / recents / enter / delete / power / volup / voldown',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_type',
      description: '往手机里打字（**只支持英文/数字/符号**，中文要用输入法，暂时不行）。',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_apps',
      description: '列出手机上装了哪些第三方 App（包名）。找 B 站/游戏用。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_open',
      description: '打开一个 App（用包名，比如 bilibili 是 tv.danmaku.bili）。支付/相册/通讯录这类会被拒绝。',
      parameters: { type: 'object', properties: { pkg: { type: 'string' } }, required: ['pkg'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_install',
      description:
        '安装一个 APK（**必须先跟主人确认过**）。只接受本机已有的文件路径 —— 先下载到磁盘再装。',
      parameters: { type: 'object', properties: { apkPath: { type: 'string' } }, required: ['apkPath'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_play',
      description:
        '**自己在手机上玩一会儿**（开 App → 看屏幕 → 点几下 → 回来跟他讲）。' +
        '⚠️ **必须先问主人**："想不想我玩会儿？" —— 他说"去/行/玩吧"**才能调这个** ✗；他没答应就别调 ✓。' +
        '玩一次有硬上限（约 1 元 token ✓、最多 4 步 ✓），模拟器没开会自己开 ✓。',
      parameters: {
        type: 'object',
        properties: { app: { type: 'string', description: '想玩哪个包名（可选，不填就自己挑一个）' } },
        required: [],
      },
    },
  },
];
/**
 * **保存他发的贴纸**（2026-10-22 用户要求：「看到他喜欢的他能不能保存和发送」✓）。
 * ⚠️ TG 的 `file_id` **会过期** ✗ ⇒ 必须**收到就下载**（telegram.mjs 已经这么做了 ✓），
 *    所以这里用的是"这条消息刚落盘的那个文件" ✓，而不是以后再去取。
 */
const SAVE_STICKER_DEF = {
  type: 'function',
  function: {
    name: 'save_sticker',
    description:
      '把**他刚发的那张贴纸**存进你自己的表情包库 ✓（以后你也能发它 ✓）。' +
      '他说「这个存下来 / 这张不错 / 记住这张」时用 ✓；**动画贴纸存不了** ✗（会告诉你原因 ✓）。' +
      '标签要短（2~6 个字，描述画面内容 ✓，比如「捂脸笑」「翻白眼」），别用"贴纸1"这种 ✗。',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: '存成什么标签（2~6 字，描述画面）' },
      },
      required: ['tag'],
    },
  },
};
TOOL_DEFS.push(SAVE_STICKER_DEF);

TOOL_DEFS.push(...PHONE_DEFS);

const PLAY_STATE = { lastAt: 0, day: '', count: 0 }; // 「自己玩手机」的当天计数 ✓
let _phone = null;
async function getPhone() {
  if (_phone) return _phone;
  const { loadConfig } = await import('./config.mjs');
  const { createPhone } = await import('./phone.mjs');
  const cfg = loadConfig({}).config;
  const p = cfg.phone ?? {};
  _phone = createPhone({ adb: p.adb, ld: p.ld, serial: p.serial, log: console });
  return _phone;
}

/** 统一入口：没启用就直接说清楚（**不抛**，永远返回字符串） */
async function phoneCall(action, args = {}) {
  try {
    const { loadConfig } = await import('./config.mjs');
    const cfg = loadConfig({}).config;
    if (!cfg.phone?.enabled) return '手机功能没启用（面板/config.json 里把 phone.enabled 设成 true，然后重启机器人）。';
    const p = await getPhone();
    if (action === 'look') {
      const shot = await p.screenshot();
      if (!shot.ok) return '看不了屏幕：' + shot.err;
      // ⚠️ 2026-10-20：游戏画面 2.7MB ⇒ 识图 30 秒超时 ✗；Unity 又没有元素表 ✗
      //    ⇒ 转 JPEG + 画 200px 网格（**不缩放** ⇒ 网格坐标=真实屏幕坐标 ✓ 不用换算）
      const { toVisionJpeg } = await import('./shotsize.mjs');
      const vjpg = await toVisionJpeg(shot.png, { grid: 200 });
      const imgB64 = (vjpg ?? shot.png).toString('base64');
      const imgMime = vjpg ? 'image/jpeg' : 'image/png';
      const { askWithImage } = await import('./llm.mjs');
      const asked = String(args.question ?? '').trim();
      // ⚠️ 2026-10-19：**别让视觉模型猜坐标** ✗ —— 实测它按缩略图报 (300,610) ✓ 在 2560x1440 上点空了 ✓。
      //    改用 uiautomator dump 的**真实 bounds** ✓✓，她照着点就准 ✓。
      const st = await p.status();
      const sizeTxt = st.ok ? String(st.size || '').replace(/^Physical size:\s*/, '') : '';
      const dump = await p.uiDump({ max: 40 });
      const listTxt = dump.ok && dump.items.length
        ? '\n界面上可点的元素（**直接用这里的中心坐标** ✓，不要自己估 ✗）：\n' +
          dump.items.map((it) => '· 「' + it.text + '」中心 (' + it.x + ',' + it.y + ')').join('\n')
        : '\n（这次**没有元素表** —— 说明是游戏画面（Unity 画布没有无障碍节点）。' +
          '图上有 **200 像素一格的红网格** ✓：照网格读出坐标再点 ✓，坐标原点在左上角、和屏幕一致、**不用换算** ✓）';
      const desc = await askWithImage(cfg, {
        system: '你是看手机屏幕的助手。只描述你**真的看到**的东西，别猜、别编。',
        prompt:
          '这是安卓手机的当前屏幕截图' + (sizeTxt ? '，屏幕像素 **' + sizeTxt + '**' : '') + '。用中文简短说清：' +
          '① 现在是什么 App / 什么页面 ② 屏幕上主要有什么' +
          '③ 想做操作该点哪里 —— **优先用下面元素表里的坐标** ✓（那是精确值 ✓）；没有元素表就照网格读 ✓。' +
          listTxt +
          (asked ? '\n用户特别想知道：' + asked : ''),
        imageBase64: imgB64,
        mime: imgMime,
        maxTokens: 500,
      });
      // ⚠️ askWithImage 返回的是 **{text, usage}** ✗（不是字符串）⇒ 直接 String() 会得到 [object Object] ✓
      return '屏幕内容：' + String(desc?.text ?? desc ?? '').trim() + (listTxt && dump.ok ? '\n\n' + listTxt.trim() : '');
    }
    if (action === 'status') {
      const s = await p.status();
      return s.ok ? '手机在线：' + s.serial + '｜型号 ' + s.model + '｜' + s.size + '｜前台 ' + (s.focus || '?') : '看不了手机：' + s.err;
    }
    if (action === 'start') {
      const s = await p.start();
      return s.ok ? s.out : '起不来：' + s.err;
    }
    if (action === 'tap') {
      // 2026-10-20：点完**必须**给她一个客观结果（屏幕有没有变）✗ 别让她靠识图猜 ✓
      const r = await p.tapVerified(args.x, args.y);
      if (!r.ok) return '点不了：' + r.err;
      const pct = r.ratio === null || r.ratio === undefined ? '' : '（变了 ' + Math.round(r.ratio * 100) + '% 的画面）';
      if (r.changed === true) return '点了（' + args.x + ',' + args.y + '）—— 屏幕**有变化** ✓' + pct + '，可以接着 phone_look 看新界面。';
      if (r.changed === false)
        return '点了（' + args.x + ',' + args.y + '）—— **屏幕没有任何变化** ✗' + pct + ' 这一下很可能是**点空了**：' +
          '把坐标挪 30~60 像素再试一次 ✓，别在同一个点反复点 ✗。';
      return '点了（' + args.x + ',' + args.y + '），但没能截到对比图（界面可能无法截图）—— 用 phone_look 自己确认一下 ✓。';
    }
    if (action === 'swipe') return p.swipe(args.x1, args.y1, args.x2, args.y2, args.ms).then((r) => (r.ok ? '滑了' : '滑不了：' + r.err));
    if (action === 'key') return p.key(args.name).then((r) => (r.ok ? '按了 ' + args.name : '按不了：' + r.err));
    if (action === 'type') return p.type(args.text).then((r) => (r.ok ? '打了字' : '打不了：' + r.err));
    if (action === 'apps') {
      const r = await p.apps();
      return r.ok ? '装了：' + (r.out.length ? r.out.join('、') : '（没有第三方 App）') : '列不出来：' + r.err;
    }
    if (action === 'open') return p.open(args.pkg).then((r) => (r.ok ? r.out : '打不开：' + r.err));
    if (action === 'install') return p.install(args.apkPath).then((r) => (r.ok ? r.out : '装不了：' + r.err));
    return '不认识的动作：' + action;
  } catch (e) {
    return '手机操作出错：' + String(e?.message ?? e).slice(0, 200);
  }
}

Object.assign(IMPL, {
  phone_status: () => phoneCall('status'),
  phone_start: () => phoneCall('start'),
  phone_look: (a) => phoneCall('look', a),
  phone_tap: (a) => phoneCall('tap', a),
  phone_swipe: (a) => phoneCall('swipe', a),
  phone_key: (a) => phoneCall('key', a),
  phone_type: (a) => phoneCall('type', a),
  phone_apps: () => phoneCall('apps'),
  phone_open: (a) => phoneCall('open', a),
  /**
   * 保存他刚发的贴纸（"收到就下载"的那份文件 ⇒ 不会碰上 file_id 过期 ✗）。
   * 存好之后顺手让视觉模型给一句描述 ✓ 写进 .descriptions.json ✓ —— 这样她以后**能按画面**发它 ✓。
   */
  save_sticker: async (args, ctx) => {
    try {
      const src = String(ctx?.lastStickerFile ?? '').trim();
      if (!src) return '没找到他刚发的贴纸文件 ✓（如果这是**动画贴纸**，本来就存不了 ✗ —— 如实告诉他）。';
      const { loadStickers, readDescriptions } = await import('./stickers.mjs');
      const { copyFileSync, existsSync, writeFileSync, readFileSync } = await import('node:fs');
      const { join, extname } = await import('node:path');
      const st = loadStickers(String(ctx?.stickersDir ?? 'stickers')); // 测试可注入临时目录 ✓
      if (!existsSync(src)) return '贴纸文件已经不在了 ✗（临时文件被清了）—— 让他再发一次 ✓。';
      const rawTag = String(args?.tag ?? '').trim().replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 12);
      if (!rawTag) return '标签不能为空 ✓（给个 2~6 字的画面描述）。';
      const ext = extname(src) || '.png';
      let dest = join(st.dir, rawTag + ext);
      let n = 2;
      while (existsSync(dest)) { dest = join(st.dir, rawTag + '-' + n + ext); n += 1; }
      copyFileSync(src, dest);
      const saved = dest.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? rawTag;

      // 顺手补一句描述（失败不影响"已保存" ✓；测试里可跳过 ✓）
      let note = '';
      if (ctx?.skipStickerDescribe === true) {
        return '存好了 ✓ 标签是「' + saved + '」—— 以后我能发它了 ✓。';
      }
      try {
        const { askWithImage } = await import('./llm.mjs');
        const { loadConfig } = await import('./config.mjs');
        const cfg = loadConfig({}).config;
        const buf = readFileSync(dest);
        const r = await askWithImage(cfg, {
          system: '你在给表情包打一句话标签。只描述画面，简短。',
          prompt: '这是一张聊天用的表情包。用一句中文说清：画面里是什么、什么表情/动作、图上的文字。30 字以内。',
          imageBase64: buf.toString('base64'),
          mime: ext.toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
          maxTokens: 80,
        });
        note = String(r?.text ?? '').trim().slice(0, 40);
        if (note) {
          const file = join(st.dir, '.descriptions.json');
          const map = readDescriptions(st.dir);
          map[saved] = note;
          writeFileSync(file, JSON.stringify(map, null, 2) + '\n', 'utf8');
        }
      } catch { /* 描述失败就算了 ✓ */ }

      return '存好了 ✓ 标签是「' + saved + '」' + (note ? '（画面：' + note + '）' : '') + ' —— 以后我能发它了 ✓。';
    } catch (e) {
      return '存贴纸出错：' + String(e?.message ?? e).slice(0, 120);
    }
  },
  phone_install: (a) => phoneCall('install', a),
  phone_play: async (a = {}) => {
    try {
      const { loadConfig } = await import('./config.mjs');
      const cfg = loadConfig({}).config;
      if (!cfg.phone?.enabled) return '手机功能没启用（config.json 里 phone.enabled = true 再重启）。';
      const { createPhone } = await import('./phone.mjs');
      const { runPlayEpisode } = await import('./phoneplay.mjs');
      const { createLLM } = await import('./llm.mjs');
      const llm = createLLM(cfg);
      const phone = createPhone({ adb: cfg.phone?.adb, ld: cfg.phone?.ld, serial: cfg.phone?.serial, log: console });
      const r = await runPlayEpisode({
        phone,
        cfg,
        ask: (m, o) => llm.chat({ system: o?.system, messages: m }),
        askWithImage,
        send: null, // 由她自己回来讲 ✓（工具没有发送通道）
        state: PLAY_STATE,
        force: true, // 主人已经点头了 ✓（预算/步数上限照旧生效 ✓）
        log: console,
      });
      return r.ok
        ? '玩完了（' + r.steps + ' 步 / ' + r.playedSec + ' 秒）：' + r.trail.join(' → ') + '\n把这段用你自己的话跟他说一遍（像分享，不是报告）。'
        : '没玩成：' + r.why;
    } catch (e) {
      return '玩手机出错：' + String(e?.message ?? e).slice(0, 200);
    }
  },
});
// ⚠️ TOOL_NAMES 是在模块加载时用 Object.keys(IMPL) 算的 ✗ —— 上面是**后追加**的 ⇒ 这里补上（2026-10-19）
TOOL_NAMES.push(...Object.keys(IMPL).filter((k) => k.startsWith('phone_')));
