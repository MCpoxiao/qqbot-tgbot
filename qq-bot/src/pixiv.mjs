/**
 * pixiv 图源（2026-10-09 用户要求「搜图能不能上 pixiv 搜」）。
 *
 * ## 前提：走代理
 *
 * 本机**直连 pixiv 不通**（实测 `pixiv.net` 与 `i.pximg.net` 都是 `fetch failed`）。
 * 代理由**启动脚本**在拉起机器人之前设进环境变量（`NODE_USE_ENV_PROXY=1` + `HTTP_PROXY`），
 * 机器人进程里所有 `fetch` 自然就走代理 —— **所以这个模块本身不碰代理**。
 * ⚠️ 为什么不能在运行时设：实测 Node 的 fetch **在启动时就固定了代理**，运行时改 `process.env` 无效。
 *
 * ## 两个接口实测（2026-10-09，经 127.0.0.1:7897）
 *
 * - 搜索：`/ajax/search/illustrations/<词>?...` → HTTP 200、`error:false`、60 条
 * - 图床：`i.pximg.net` → HTTP 200（**必须带 `Referer: https://www.pixiv.net/`**，否则 403）
 *
 * ## 注意
 *
 * - 搜索结果里给的是**缩略图/中等尺寸**地址；`_master1200` 是常见可用尺寸（原图通常要登录）。
 * - 只挑 `illust`（插画）与 `manga`，`novel` 不是图。
 * - 这个模块**不做合规判断**（pixiv 上有 R-18）—— 筛选交给"发前筛一遍"那道闸。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADULT_KNOWN_TAGS, aliasFormsFor, searchTagFor, WORK_KNOWN_TAGS } from './pixiv-tags.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/**
 * **登录 cookie**（2026-10-10 用户提供账号）。
 *
 * 为什么需要：pixiv 的 R-18 作品**必须登录**才看得到原图、才下得下来
 * （未登录时作品接口 ajax/illust/<id> 对 R-18 直接 404）。
 * 放法：把浏览器里的 cookie 存成**一行文本**放进 `qq-bot/pixiv-cookie.txt`
 * （含 `PHPSESSID` 与 `SESSDATA` 即可）。**这个文件不入归档、不进记忆**（凭据）。
 */
/**
 * cookie 文件位置：**按模块自身位置解析**，不依赖当前工作目录。
 * ⚠️ 2026-10-10 踩过：原来用 `resolve(process.cwd(), …)`，从工作区根目录跑就找不到文件
 * （机器人是以 qq-bot 为目录启动的，所以生产里碰巧能读到 —— 但这种"碰巧"迟早出事）。
 * 跟 `bilibili.mjs` 的 COOKIE_FILE 用同一套写法。
 */
const PIXIV_COOKIE_PATH = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'pixiv-cookie.txt');

export function pixivCookie() {
  const f = process.env.PIXIV_COOKIE_FILE || PIXIV_COOKIE_PATH;
  try {
    if (!existsSync(f)) return '';
    /**
     * 允许文件里写注释：**以 # 开头的行整行忽略** ✓。
     *
     * ⚠️ **2026-10-28 修**：原来把剩下的行用**空格**拼起来 ✗ —— 那是错的 ✓：
     *   · 一行 `PHPSESSID=abc` ✓、下一行 `SESSDATA=def` ✓ ⇒ 拼成 `PHPSESSID=abc SESSDATA=def` ✗
     *     （cookie 头要的是 `; ` 分隔 ✗）；
     *   · 而用户从浏览器扩展导出的常是 **Netscape 格式** ✓（`域名 \t 标记 \t 路径 \t 安全 \t 过期 \t 名 \t 值` ✓），
     *     用空格拼完是一坨 ✗ ⇒ 发出去会被 undici 报 `Cannot convert argument to a ByteString` ✓。
     * 现在：两种格式都认 ✓，统一拼成 `名=值; 名=值` ✓；**每次调用重读文件**（填完不用重启 ✓）。
     */
    const pairs = [];
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const cols = l.split('\t');
      if (cols.length >= 7) {
        // Netscape：最后一列是值，倒数第二列是名字
        const name = cols[cols.length - 2].trim();
        const value = cols[cols.length - 1].trim();
        if (name && value) pairs.push(name + '=' + value);
        continue;
      }
      // 普通写法：`name=value`（一行可以有多个，用 ; 分开）
      for (const part of l.split(';')) {
        const p = part.trim();
        if (p && p.includes('=')) pairs.push(p);
      }
    }
    // 去重（同名只留最后一个 ✓）
    const map = new Map();
    for (const p of pairs) {
      const i = p.indexOf('=');
      map.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
    return [...map.entries()].map(([k, v]) => k + '=' + v).join('; ');
  } catch {
    return '';
  }
}

/** pixiv 请求头（有 cookie 就带上 —— 登录后 R-18 才可见）。 */
function pixivHeaders(extra = {}) {
  const ck = pixivCookie();
  return {
    'user-agent': UA,
    referer: 'https://www.pixiv.net/',
    'accept-language': 'zh-CN,zh;q=0.9',
    ...(ck ? { cookie: ck } : {}),
    ...extra,
  };
}

/**
 * **搜索专用请求头：不带 cookie**（2026-10-14 实测加的，修一个把"搜图"废掉的真 bug）。
 *
 * 实测（同一时刻、都走 mihomo 代理）：
 * | 请求 | 结果 |
 * | --- | --- |
 * | `ajax/search/artworks/白丝` **不带 cookie** | **HTTP 200、60 条候选、total=7695、4.0 秒** ✓ |
 * | 同一 URL **带 `pixivHeaders()` 的 cookie**（`qq-bot/pixiv-cookie.txt`，10-10 存的） | ✗ **20 秒超时** |
 *
 * ⇒ 那份 cookie 已经失效，带着它会让**本来能成功的请求拖到超时** ✗✗（而搜索接口**匿名就能用** ✓）。
 * cookie 只在**下 R-18 原图**（`fetchPixivImage` / `fetchPixivWork`）时才需要 ✓，那边继续用 `pixivHeaders()`。
 */
function pixivSearchHeaders(extra = {}) {
  return {
    'user-agent': UA,
    referer: 'https://www.pixiv.net/',
    'accept-language': 'zh-CN,zh;q=0.9',
    ...extra,
  };
}

/**
 * 按**作品号**取一张图（用户：「也可以说 pixiv 好让他去下载发出来」→ 说 `pixiv 12345` 或贴作品链接）。
 * 走作品接口拿**原始地址**；R-18 需要 cookie（没有会给出明确原因）。
 */
export async function fetchPixivWork(id, { timeoutMs = 20000 } = {}) {
  const n = String(id ?? '').match(/(\d{5,12})/)?.[1];
  if (!n) throw new Error('作品号看起来不对');
  const r = await fetch(`https://www.pixiv.net/ajax/illust/${n}`, {
    headers: pixivHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.status === 404) {
    throw new Error(`作品 ${n} 取不到（不存在，或者是 R-18 而我没登录 —— 需要 pixiv-cookie.txt）`);
  }
  if (!r.ok) throw new Error(`pixiv 作品接口 HTTP ${r.status}`);
  const j = await r.json();
  if (j?.error) throw new Error(`pixiv 报错：${j.message ?? j.error}`);
  const b = j?.body ?? {};
  const url = String(b?.urls?.original ?? b?.urls?.regular ?? '');
  if (!url) throw new Error('这个作品没有可用图片地址');
  return {
    id: n,
    title: String(b?.title ?? '').trim(),
    author: String(b?.userName ?? '').trim(),
    authorId: String(b?.userId ?? ''),
    /**
     * ⚠️ **2026-10-11 补**（漫画打包要用）：`pageCount` = 这个作品有几页；
     * `illustType` = 0 插画 / 1 漫画 / 2 动图；`createDate` = 发布日
     *（zip 命名里的"时间"用它，比"我打包那天"更有意义）。都带默认值，老调用方不受影响。
     */
    pageCount: Number(b?.pageCount ?? 1) || 1,
    illustType: Number(b?.illustType ?? 0) || 0,
    createDate: String(b?.createDate ?? ''),
    tags: Array.isArray(b?.tags?.tags)
      ? b.tags.tags.map((t) => String(t?.tag ?? '')).filter(Boolean).slice(0, 10)
      : [],
    xRestrict: Number(b?.xRestrict ?? 0),
    url,
    pageUrl: pixivPageUrl(n),
  };
}

/** 从分页接口的 JSON 里抠出每页原图地址（**纯函数**，自测直接喂样本，不打网络）。 */
export function parsePixivPages(json, { maxPages = 200 } = {}) {
  const body = Array.isArray(json?.body) ? json.body : [];
  const out = [];
  for (const [i, p] of body.entries()) {
    const url = String(p?.urls?.original ?? p?.urls?.regular ?? '');
    if (url) out.push({ page: i, url });
    if (out.length >= maxPages) break;
  }
  return out;
}

/**
 * **取一个作品所有页的原图地址**（2026-10-11 用户要的「漫画下载 → 压成 zip」）。
 *
 * 走的接口是 `ajax/illust/<id>/pages?lang=zh`（**要 cookie**：R-18 未登录会 404，
 * 与作品接口同一个坑）。返回 `[{ page, url }]`；失败**明确抛错**，不返回空数组
 * —— 空数组会被上游当成"这个作品没有图"，然后发一个空包出去（`memory/lessons.md`
 * 里"空数组 ≠ 没数据，可能是没登录"那条）。
 */
export async function fetchPixivPages(id, { timeoutMs = 25000, maxPages = 200 } = {}) {
  const n = String(id ?? '').match(/(\d{5,12})/)?.[1];
  if (!n) throw new Error('作品号看起来不对');
  const r = await fetch(`https://www.pixiv.net/ajax/illust/${n}/pages?lang=zh`, {
    headers: pixivHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.status === 404) {
    throw new Error(`作品 ${n} 的分页接口 404（不存在，或者是 R-18 而我没登录 —— 需要 pixiv-cookie.txt）`);
  }
  if (!r.ok) throw new Error(`pixiv 分页接口 HTTP ${r.status}`);
  const j = await r.json();
  if (j?.error) throw new Error(`pixiv 报错：${j.message ?? j.error}`);
  const out = parsePixivPages(j, { maxPages });
  if (!out.length) throw new Error(`作品 ${n} 的分页接口没给出任何图片地址`);
  return out;
}

/* ============================ 漫画打包（zip）============================ */

/** 文件名里不能出现的字符（Windows 规则最严）+ 控制字符。 */
export function safeFileNamePart(s, { max = 40 } = {}) {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * 打包文件名：**`pid_作者_时间_部分标签.zip`**（用户 2026-10-10 指定的格式，例
 * `150652008_みっくすちゃん_20261010_白丝.zip`）。
 *
 * 规则（纯函数，可测）：
 *  · 时间取**作品发布日**（`createDate`，形如 `2026-10-10T12:34:56+09:00`）→ `20261010`；
 *    取不到就退回**打包当天**，再取不到就省略这一段；
 *  · 标签优先用**用户这次点名/要求的那批**（他想要什么，文件名里就写什么），
 *    否则取作品标签里**前两个"有信息量的"**（跳过 R-18/R18/分级词与作品名本身）；
 *  · 每段都过 `safeFileNamePart`（去非法字符、限长）。
 */
export function pixivZipName({ id, author, date, tags = [], askedTags = [] } = {}) {
  const pick = [];
  for (const t of askedTags) {
    const s = safeFileNamePart(t, { max: 16 });
    if (s && !pick.includes(s) && !/^r-?18g?$/i.test(s)) pick.push(s);
    if (pick.length >= 2) break;
  }
  if (!pick.length) {
    for (const t of tags) {
      const s = safeFileNamePart(t, { max: 16 });
      if (!s || pick.includes(s)) continue;
      if (/^r-?18g?$/i.test(s) || /^(r18|r-18|r18g|原创|オリジナル|イラスト|illustration)$/i.test(s)) continue;
      pick.push(s);
      if (pick.length >= 2) break;
    }
  }
  const day = String(date ?? '').match(/(\d{4})-?(\d{2})-?(\d{2})/);
  const stamp = day ? `${day[1]}${day[2]}${day[3]}` : '';
  const parts = [
    safeFileNamePart(id, { max: 20 }) || 'pixiv',
    safeFileNamePart(author, { max: 24 }) || '佚名',
    stamp || safeFileNamePart(new Date().toISOString().slice(0, 10).replace(/-/g, ''), { max: 8 }),
    pick.join('_'),
  ].filter(Boolean);
  return `${parts.join('_')}.zip`;
}

/**
 * 这个场景能不能用 pixiv（纯函数，可测）。
 *
 * 规矩（2026-10-09 用户）：「**有点私心，还是想让它可以搜来发我自己的，群里要限制一下**」
 * → **只有主人的私聊**能用 pixiv；**群里一律走 Bing**（避免把不适合群里的图发出去）。
 */
export function pixivAllowedFor(target, state) {
  if (target?.type !== 'private') return false;
  const masters = (state?.master?.users ?? []).map(String);
  return masters.includes(String(target?.id ?? ''));
}

/** pixiv 搜索页 URL（人看的那个）。 */
export function pixivPageUrl(id) {
  return `https://www.pixiv.net/artworks/${id}`;
}

/**
 * 由作品 id 拼出**可直接下载**的图地址。
 *
 * 形如 `https://i.pximg.net/img-master/img/<date>/<id>_p0_master1200.jpg` 需要日期分片，
 * 而搜索结果里已经给了 `url`（形如 `…/c/540x540_70/img-master/img/2026/10/09/…_p0_master1200.jpg`），
 * 所以**优先用搜索结果自带的 url**，这个函数只作为兜底。
 */
export function pixivImageUrl(id, page = 0, datePath = '') {
  if (!id) return '';
  const d = String(datePath).replace(/^\/+|\/+$/g, '');
  return d
    ? `https://i.pximg.net/img-master/img/${d}/${id}_p${page}_master1200.jpg`
    : `https://i.pximg.net/img-original/img/${id}_p${page}.jpg`;
}

/** 把搜索结果里的缩略地址换成更大的（`c/540x540_70/` 前缀去掉 → 原尺寸档）。 */
export function biggerPixivUrl(url) {
  return String(url ?? '').replace('/c/540x540_70/', '/').replace('/c/250x250_80_a2/', '/');
}

/**
 * 搜 pixiv（**要代理**，见文件头）。
 * @returns {Promise<Array<{id:string,title:string,url:string,pageUrl:string,tags:string[],author:string}>>}
 */
export async function pixivSearch(query, { count = 12, timeoutMs = 20000, mode = 'all' } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  // `mode=safe` 是 pixiv 自己的安全档（群里用这个更稳）；`all` = 不过滤（主人的私聊）。
  const m = mode === 'safe' ? 'safe' : 'all';
  /**
   * ⚠️ **接口名是 `artworks`，不是 `illustrations`**（2026-10-14 实测修）：
   * `ajax/search/illustrations/…` 现在**直接失败**（5 秒 fetch failed ✗），
   * 而 `ajax/search/artworks/…` **正常返回** ✓（实测「白丝」→ 60 条候选、total 7695 ✓）。
   * ⇒ 这是"搜图从来不优先 pixiv / 老是搜到网页垃圾"的**主因** ✗（搜索一直返回 0 条 ⇒ 悄悄退给 Bing ✗）。
   * 请求头用 `pixivSearchHeaders()`（**不带那份失效 cookie** ✓，见它的注释）。
   */
  const api =
    `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(q)}` +
    `?word=${encodeURIComponent(q)}&order=date_d&mode=${m}&p=1&s_mode=s_tag&type=all&lang=zh`;
  /**
   * ⚠️ **重试两次**（2026-10-14 实测加）：经 mihomo 到 pixiv 的链路**时好时坏** ——
   * 同一时刻、同一 URL 实测出现过「265ms 成功 ✓」和「连续 8 次 5 秒 fetch failed ✗」。
   * 一次失败就退给 Bing ⇒ 结果就是"搜图老是搜到网页垃圾" ✗（用户 2026-10-14 报的）。
   * 所以：**短超时 + 重试**，并且把每次失败都**说出来**（不再静默 ✗）。
   */
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const r = await fetch(api, {
        headers: pixivSearchHeaders(),
        signal: AbortSignal.timeout(Math.min(Number(timeoutMs) || 20000, 12000)),
      });
      if (!r.ok) throw new Error(`pixiv 搜索 HTTP ${r.status}`);
      const j = await r.json();
      if (j?.error) throw new Error(`pixiv 搜索报错：${String(j.message ?? j.error)}`);
      const list = j?.body?.illustManga?.data ?? j?.body?.illust?.data ?? [];
      const out = [];
      for (const it of list) {
        if (!it?.id) continue;
        const raw = String(it.url ?? '');
        const url = biggerPixivUrl(raw) || pixivImageUrl(it.id);
        out.push({
          id: String(it.id),
          title: String(it.title ?? '').trim(),
          url,
          pageUrl: pixivPageUrl(it.id),
          tags: Array.isArray(it.tags) ? it.tags.slice(0, 8) : [],
          author: String(it.userName ?? ''),
          xRestrict: Number(it.xRestrict ?? 0),
        });
        if (out.length >= count) break;
      }
      if (out.length || attempt === 2) return out;
      lastErr = new Error('第 1 次拿到 0 条，重试一次');
    } catch (err) {
      lastErr = err;
      if (attempt === 2) throw err;
    }
  }
  throw lastErr ?? new Error('pixiv 搜索失败');
}

/** 下图（**必须带 Referer**，否则 i.pximg 返 403）。 */
export async function fetchPixivImage(url, { timeoutMs = 30000 } = {}) {
  const r = await fetch(url, {
    headers: pixivHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`pixiv 下图 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('pixiv 图是空的');
  return buf;
}

/* ============================ 标签搜索 / 过滤 ============================ */

/**
 * 从一句话里拆出**标签**和**关键词**（2026-10-10 用户要求）。
 *
 * 约定：`【】`里的就是标签，其余是角色/主题名。用户原话：
 * 「帮我找一个【白丝】【萝莉】洁尔佩塔」→ 标签 = [白丝, 萝莉]，关键词 = 洁尔佩塔。
 * **标签不是必须的** —— 没说标签就正常搜，不要因此追问或拒绝。
 */
/**
 * **常见标签词**（2026-10-10 用户实测）：他写「帮我找洁哥的白丝图」时，「白丝」是**裸词**、不带【】——
 * 只认【】就等于把标签丢了（发出来的图当然没有白丝）。这里内置一份，裸写也算标签。
 *
 * ⚠️ **2026-10-10 下午**：R-18 那一大批题材词单独放在 `src/pixiv-tags.mjs`
 * （按**同义组**维护：`['顔射','颜射',…]`，第一个是首选搜索词、其余是识别/匹配别名），
 * 在下面拼进 `DEFAULT_KNOWN_TAGS` —— 用户那句话里的裸词要能被认出来，
 * **而且**搜出去/比对时要换成 pixiv 上真有的写法（见 `searchTagFor` / `aliasFormsFor`）。
 */
/**
 * **老词表**（2026-10-10 之前就在用的那批）。
 * 导出只为自测能验一条结构不变量：**它和 R-18 新词表必须不相交** ——
 * 老词的搜索写法不许被新表悄悄改掉（见 `selftest.mjs` 的「老词不许动」）。
 */
export const LOCAL_KNOWN_TAGS = [
  // ── 袜/腿/足（用户点名的那几个在最前）──
  '白丝', '黑丝', '裤袜', '足底', '裸足', '丝袜', '白丝袜', '黑丝袜', '过膝袜', '大腿袜',
  '吊带袜', '网袜', '泡泡袜', '短袜', '靴下', '足', '脚', '脚底', '足裏', '美腿', '长腿',
  '大腿', '绝对领域', '膝上袜', '裸腿',
  // ── 服饰/制服 ──
  '女仆', '女仆装', '旗袍', '和服', '浴衣', '水手服', 'jk制服', '制服', '校服', '泳装',
  '死库水', '比基尼', '兔女郎', '护士服', '婚纱', '礼服', '洛丽塔', '汉服', '运动服',
  '紧身衣', '皮衣', '大衣', '围巾', '手套', '眼镜', '眼罩', '面具', '帽子', '发带', '项圈',
  'choker', '白大褂', '西装', '背带裤', '短裤', '热裤', '毛衣', '衬衫',
  // ── 体型/特征 ──
  // ⚠️ 2026-10-10 14:4x 我按用户当时那句「太畜牲了」把「幼女」摘了；
  //    **14:5x 用户改口：「幼女原本有的话就留着」→ 已按原样恢复**（用户当场的话最优先，记忆与注释都以他为准）。
  //    同一次他还要求：**兽耳/猫耳…和兽尾（尻尾/尾巴/しっぽ）都留着**（猫娘之类）。
  //    `src/pixiv-tags.mjs` 顶部记着这条来龙去脉；自测里钉的是**最终状态**。
  '萝莉', '正太', '御姐', '少女', '幼女', '美少女', '熟女', '贫乳', '巨乳', '兽耳', '猫耳',
  '兔耳', '狐耳', '犬耳', '精灵耳', '短发', '长发', '双马尾', '单马尾', '马尾', '丸子头',
  '呆毛', '白发', '黑发', '金发', '粉发', '红发', '蓝发', '绿发', '银发', '白毛', '双色瞳',
  '异色瞳', '红瞳', '蓝瞳', '纹身', '肌肉', '腹肌', '锁骨', '肚脐', '耳朵',
  // ── 类型/风格 ──
  '壁纸', '立绘', '头像', '表情包', '同人', '插画', 'q版', '线稿', '厚涂', '像素', '动图',
  '素描', '水彩', '赛璐璐', '全身', '半身', '特写', '横图', '竖图', '拼图', '多图',
  // ── 分级（群里会被 safe 档再兜一道，私聊不限）──
  'r-18', 'r-18g', 'r18', 'r18g', '一般向', '全年龄', '微工口', '着衣', '露出',
  // ── 身份/设定 ──
  '天使', '恶魔', '精灵', '吸血鬼', '魔法少女', '巫女', '修女', '忍者', '武士', '骑士',
  '公主', '女王', '偶像', '歌手', '护士', '老师', '司令官', '舰娘', '老板娘', '小姐',
  // ── 常见作品（用户点名 碧蓝档案；同类一起给上）──
  '碧蓝档案', '蔚蓝档案', '原神', '崩坏3', '崩坏星穹铁道', '绝区零', '明日方舟',
  '明日方舟终末地', '少女前线', '无期迷途', '尘白禁区', '碧蓝航线', '舰队collection',
  '公主连结', '赛马娘', '偶像大师', 'lovelive', '东方project', '东方', '初音未来', 'vocaloid',
  'fate', 'fgo', '尼尔', '最终幻想', '宝可梦', '塞尔达', '女神异闻录', '异度神剑', '火焰纹章',
  '死或生', '拳皇', '街头霸王', '罪恶装备', '艾尔登法环', '巫师3', '上古卷轴', '我的世界',
];

/** 老词 + R-18 题材词（`src/pixiv-tags.mjs`）+ 作品名同义写法，合成一张识别表。 */
export const DEFAULT_KNOWN_TAGS = [...LOCAL_KNOWN_TAGS, ...ADULT_KNOWN_TAGS, ...WORK_KNOWN_TAGS];

/** 正则转义（词表里可能有 `-` `.` `+` 这类字符）。 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * **否定短语**：用户说「不要 r18」「没有 r18」「别带【白丝】」时要**排除**那个标签。
 *
 * 为什么必须做（2026-10-10 17:0x 用户报 + 日志实证）：他说
 * 「帮我找八重神子**没有r18**的图」，代码把那句里的 `r18` 当成**正向标签**去搜，
 * 搜索词变成「八重神子没有」→ 0 条；而前一天他要「八重神子的图」时收到的是 R-18 图，
 * 他回「有点劲啊，上来就是r18」—— **排除**这个需求是真实存在的，只是当时没实现。
 *
 * 标记词覆盖他可能怎么说话：不要 / 不想要 / 别要 / 别带 / 不要带 / 不带 / 没有 / 去掉 /
 * 去除 / 排除 / 除了 / 拒绝 / 屏蔽 / 避开 / no ——（判据同 `memory/lessons.md`：
 * **要认"这类说法"，不要只认那一个词**。）
 */
const EXCLUDE_MARKER = '(?:不要|不想要|别要|别带|不要带|不带|没有|去掉|去除|排除|除了|拒绝|屏蔽|避开|(?<![A-Za-z])no(?![A-Za-z]))';

/** 一个"标签样"的词：不含标点/空白，最多 24 字。 */
const TOKEN = '([^\\s，。,.、；;！!？?【】\\[\\]]{1,24})';

/** 把否定短语里那个词归一成"标签本身"（去掉尾巴上的「的图」之类）。 */
function cleanExcludeToken(tok) {
  return String(tok ?? '')
    .trim()
    .replace(/(?:的)?(?:图|图片|照片|壁纸|图包|插画|色图)$/, '')
    .replace(/^[【\[]+|[】\]]+$/g, '')
    .replace(/^(?:要|带|有|看|发)+/, '')
    .replace(/[的了吧呀啊呗嘛哈哦噢]+$/, '')
    .trim();
}

/** `r18 / R-18 / r18g` 这类"分级"词（排除它们时要连 `xRestrict` 一起看）。 */
export function isAdultTagWord(word) {
  return /^r-?18g?$/i.test(String(word ?? '').trim()) || /^r18g?$/i.test(String(word ?? '').trim());
}

/**
 * 从一句话里挑出**要排除的标签**（纯函数，可测）。
 * 只认三种：① `【】` 里明确写的；② 词表里有的标签词；③ `r18/r-18/r18g` 这类分级词。
 * 其余一律**不当排除**（否则「不要脸」「没有图」「我不要了」都会被当成排除，误伤正常句子）。
 */
export function parseExcludeTags(text, { knownTags = DEFAULT_KNOWN_TAGS } = {}) {
  const raw = String(text ?? '');
  const list = (knownTags ?? []).map((t) => String(t).trim()).filter(Boolean);
  const byLower = new Map(list.map((t) => [t.toLowerCase(), t]));
  const out = [];
  const re = new RegExp(`${EXCLUDE_MARKER}\\s*[【\\[]?${TOKEN}[】\\]]?`, 'gi');
  for (const m of raw.matchAll(re)) {
    const tok = cleanExcludeToken(m[1]);
    if (!tok || tok.length < 2) continue;
    const explicit = /[【\[]/.test(m[0]); // 用户自己用【】框起来的，一律算数
    if (!explicit && !byLower.has(tok.toLowerCase()) && !isAdultTagWord(tok)) continue;
    const canon = byLower.get(tok.toLowerCase()) ?? tok; // 归一成词表里的写法（R-18 → r-18）
    if (!out.includes(canon)) out.push(canon);
  }
  return out;
}

/**
 * 把"否定短语"整段从文本里剪掉，同时给出排除清单。
 * 为什么要剪整段：只剪掉标签本身的话，「八重神子**没有**r18」会剩下「八重神子没有」，
 * 而它会被当搜索词去搜（日志实证：`[找图] 「八重神子没有」… 0 条` ✗）。
 */
export function stripExclusions(text, { knownTags = DEFAULT_KNOWN_TAGS } = {}) {
  const exclude = parseExcludeTags(text, { knownTags });
  const raw = String(text ?? '');
  if (!exclude.length) return { exclude, cleaned: raw };
  const list = (knownTags ?? []).map((t) => String(t).trim()).filter(Boolean);
  const byLower = new Map(list.map((t) => [t.toLowerCase(), t]));
  const re = new RegExp(`${EXCLUDE_MARKER}\\s*[【\\[]?${TOKEN}[】\\]]?`, 'gi');
  const cleaned = raw.replace(re, (whole, tokRaw) => {
    const tok = cleanExcludeToken(tokRaw);
    const explicit = /[【\[]/.test(whole);
    const ok = (tok.length >= 2 && explicit) || byLower.has(tok.toLowerCase()) || isAdultTagWord(tok);
    return ok ? ' ' : whole; // 认出来才剪；认不出就原样留着（别误伤）
  });
  return { exclude, cleaned };
}

/** 词表里的词有没有出现在这句话里。
 *
 * ⚠️ **2026-10-10 16:0x 用户贴了一张作品标签截图问"覆盖了吗"**，一查发现：
 * `R-18` / `R18`（**大写**）**根本没被认出来** —— 老表里存的是小写 `r-18`，
 * 而匹配用的是 `keyword.includes(t)`（大小写敏感）✗。截图里 pixiv 显示的正是大写 `R-18`。
 *
 * 现在：**含 ASCII 字母的词忽略大小写**，并且要求**词边界**
 * （`(?<![A-Za-z0-9])…(?![A-Za-z0-9])`）—— 不然短标签会误伤正常英文：
 * 例如 `SM` 会命中 "**sm**all"、`OL` 会命中 "**ol**d"。
 */
function hasBare(text, tag) {
  if (!/[A-Za-z]/.test(tag)) return text.includes(tag); // 纯中日文：原样包含
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(tag)}(?![A-Za-z0-9])`, 'i').test(text);
}

/** 把命中的那个词从关键词里摘掉（同样忽略大小写、同样要求词边界）。 */
function removeBare(text, tag) {
  if (!/[A-Za-z]/.test(tag)) return text.split(tag).join(' ');
  return text.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(tag)}(?![A-Za-z0-9])`, 'gi'), ' ');
}

export function parseTagQuery(text, { knownTags = DEFAULT_KNOWN_TAGS } = {}) {
  // 先把「不要 X / 没有 X」整段剪掉，再在剩下的文本上解析（顺序很重要，见 stripExclusions）
  const { exclude, cleaned } = stripExclusions(text, { knownTags });
  const raw = cleaned;
  const tags = [];
  for (const m of raw.matchAll(/[【\[]([^】\]]{1,24})[】\]]/g)) {
    const t = String(m[1]).trim();
    if (t && !tags.includes(t)) tags.push(t);
  }
  // 词表里的词**裸写也算标签**，并从关键词里摘掉（免得既当标签又当搜索词）
  let keyword = raw;
  for (const kt of knownTags ?? []) {
    const t = String(kt ?? '').trim();
    if (t.length < 2 || !hasBare(keyword, t)) continue;
    if (!tags.includes(t)) tags.push(t);
    keyword = removeBare(keyword, t);
  }
  keyword = keyword
    .replace(/[【\[][^】\]]{1,24}[】\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  /** `exclude` = 用户明确说**不要**的标签（「不要 r18」）；调用方要一路传到搜索与筛图闸。 */
  return { tags, keyword, exclude };
}

/**
 * **剥掉"请求套话"**（2026-10-10 用户实测）：
 * 他说「找找白丝的图」→ 标签解析出「白丝」✓，但剩下的关键词是「找找的图」✗ →
 * 拿这个去搜当然 0 条。所以把 找/帮我找/几张/来点…的图 这类套话剥掉；
 * **剥完是空的就说明他只是想要这个标签** → 让调用方用标签当搜索词。
 */
export function stripImageAskBoilerplate(text) {
  let s = String(text ?? '').trim();
  /**
   * ⚠️ **2026-10-10 17:0x 补**：日志里两次「没搜到」是**套话没剥干净**造成的 ——
   *   · 「你帮我找八重神子」→ 原样拿去搜（前缀 `你` 不在词表里）→ 0 条 ✗
   *   · 「请问八重神子」→ 剥成「**问**八重神子」（`请` 被剥掉、`问` 留着）→ 0 条 ✗
   *   · 「麻烦你找八重神子的图」→ 剥成「**你找**八重神子」→ 0 条 ✗
   * 现在把"客气话"和"请求动词"分开、**反复剥几轮**（剥掉 `你` 之后 `帮我`、`找` 才会露出来）。
   */
  const POLITE = /^(?:你|您|请问|请|麻烦你|麻烦|不好意思|帮我|帮忙|给我|能不能|能帮我|你可以|你能|可以|想|想要|那|再|又|还|多)+/;
  const VERB = /^(?:找找|搜搜|找一下|找|搜|来几张|来个|来点|来|给|要|发|看看|想看)+/;
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    s = s.replace(POLITE, '').replace(VERB, '');
    if (s === before) break;
  }
  s = s.replace(/(?:几张|几张图|几幅|几个|一点|点儿|一些|些|点|个|张|幅)+/g, ' ');
  s = s.replace(/的?(?:图|图片|照片|壁纸|图包|插画|同人图|色图)$/g, ' ');
  s = s.replace(/[的了吧呀啊呗嘛哈哦噢]$/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 作品是否命中某个标签（一律小写包含比，中英混排也不吃亏）。
 *
 * ⚠️ **2026-10-10 下午**：比对要**认同义写法** —— 用户说「颜射」，作品上写的是「顔射」，
 * 只比原词就永远命中不了（于是 `pickByTags` 一路退到 `none` = 拿泛结果，
 * 标签等于白加）。这里把那个词所在**同义组**里所有写法都比一遍（`aliasFormsFor`）。
 */
export function hasTag(item, tag) {
  const forms = aliasFormsFor(tag).map((x) => String(x).toLowerCase().trim()).filter(Boolean);
  if (!forms.length) return false;
  const tags = (item?.tags ?? []).map((x) => String(x).toLowerCase());
  return forms.some((f) => tags.some((t) => t.includes(f)));
}

/** 命中**全部**标签（交集 —— 优先用这个）。 */
export function hasAllTags(item, tags) {
  return (tags ?? []).every((t) => hasTag(item, t));
}

/** 命中**任一**标签（退而求其次）。 */
export function hasAnyTag(item, tags) {
  return (tags ?? []).some((t) => hasTag(item, t));
}

/**
 * 成人内容判定。**群里过滤 r-18 / r-18g，私聊不限**（用户 2026-10-10 再次强调）。
 * 两个依据都看：pixiv 的 `xRestrict`（1=R-18、2=R-18G）和标签本身。
 */
export function isAdultItem(item) {
  if (Number(item?.xRestrict ?? 0) >= 1) return true;
  return (item?.tags ?? []).some((t) => /r-?18/i.test(String(t)));
}

/**
 * **排除筛选**（用户 2026-10-10 17:0x 要求：「我说不要【标签】发来的图，就不要带那个标签的」
 * —— 例「帮我找八重神子**不要 r18** 的图」）。
 *
 * 纯函数，方便单测；两个口径：
 *   · 排除词是分级词（`r18 / r-18 / r18g`）→ 用 `isAdultItem()` 判（**看 `xRestrict` 字段，
 *     比只看标签可靠** —— 有些作品标签里根本不写 R-18）；
 *   · 其余词 → 走 `hasTag()`（**认同义写法**：说不要「白丝」，`白絲`/`白タイツ` 也算命中）。
 */
export function filterExcluded(items, exclude = []) {
  const list = Array.isArray(items) ? items : [];
  const words = (Array.isArray(exclude) ? exclude : []).map((t) => String(t).trim()).filter(Boolean);
  if (!words.length) return { kept: list, dropped: 0, droppedBy: {} };
  const adultOut = words.some((w) => isAdultTagWord(w));
  const kept = [];
  const droppedBy = {};
  let dropped = 0;
  for (const it of list) {
    const hit = words.find((w) => (isAdultTagWord(w) ? isAdultItem(it) : hasTag(it, w)));
    if (hit) {
      dropped += 1;
      droppedBy[hit] = (droppedBy[hit] ?? 0) + 1;
      continue;
    }
    kept.push(it);
  }
  void adultOut;
  return { kept, dropped, droppedBy };
}

/**
 * **"一张都没发出去"到底为什么**（纯函数，可测）。
 *
 * ⚠️ 2026-10-10 17:0x 修的一条**会冤枉 NapCat 的文案**（日志实证 08:55:36）：
 * 那次「找到 2 张、发出 0 张」其实是**两张都被筛图闸筛掉了**（理由「图中人物与八重神子无关」），
 * 而代码一律写「**一张都没发出去（NapCat 那边失败了）**」→ 用户和下一个我都跑去查 NapCat ✗，
 * 机器人也照着这句话对用户说「那边卡住了」。
 * 同族教训（`memory/lessons.md`）：**别把"我这儿没发"说成"平台发不出去"**。
 *
 * @param {{query?:string, found?:number, kept?:number, screenedOut?:number, sendFailed?:number,
 *          excludedOut?:number, exclude?:string[]}} p
 */
export function describeNoSend({ query = '', found = 0, kept = 0, screenedOut = 0, sendFailed = 0, excludedOut = 0, exclude = [] } = {}) {
  if (sendFailed) {
    return `找到 ${found} 张，但**往 QQ 发的时候失败了**（${sendFailed} 张都没成功 —— 这是**发送环节**的问题，不是没搜到）。`;
  }
  if (screenedOut) {
    return (
      `找到 ${kept} 张，但**一张都没发**：${screenedOut} 张被我逐张看过后判为不合适` +
      `（跟「${query}」不相关${exclude.length ? `，或者带着你说不要的${exclude.map((t) => `【${t}】`).join('')}` : ''}）。` +
      '换个说法（加个作品名/风格词）我再找。'
    );
  }
  if (excludedOut) {
    return `找到的 ${excludedOut} 张全带着你说不要的标签（${exclude.join(' / ') || '—'}），一张都没发。`;
  }
  return `找到 ${found} 张，但一张都没发出去（原因不确定，看日志）。`;
}

/**
 * 带标签的搜索：**广泛匹配**（用户要求：优先两个标签都有，搜不到再单标签搜）。
 *
 * @param {{keyword:string, tags?:string[], exclude?:string[], count?:number, safe?:boolean}} opts
 *        `safe:true`（默认）→ 用 pixiv 的 `mode=safe` 并且**再按标签/字段兜一道**（群里）；
 *        `safe:false` → 不过滤（主人的私聊）。
 *        `exclude` → 用户明确说**不要**的标签（「不要 r18」），命中就丢掉（见 `filterExcluded`）。
 * @returns {Promise<{items:Array, matched:'all'|'tag'|'any'|'none', searchLevel:'all'|'tag'|'none', dropped:number, excluded:number, usedWord:string}>}
 *          `matched` = **标签命中程度**（`pickByTags` 的结论）；`searchLevel` = 搜索时用没用上标签；
 *          `excluded` = 被"不要的标签"筛掉的条数。
 */
export async function pixivSearchTagged({ keyword, tags = [], exclude = [], count = 12, safe = true } = {}) {
  /**
   * **标签并进搜索词，逐级放宽**（2026-10-10 用户实测）：
   * pixiv 的搜索是**标签式**的 —— 实测「洁尔佩塔」→ 8 条（里面没有白丝的），
   * 而「洁尔佩塔 白丝」→ 2 条（pixiv 会做标签归一）。
   * 所以：
   *   ① 先用「关键词 + 全部标签」；② 没结果就只带**第一个**标签；③ 再没有就**不带标签**。
   * **拿到就停** —— 这就是用户要的"优先都有，搜不到再单标签搜"。
   */
  const attempts = [];
  /**
   * ⚠️ **2026-10-10 下午**：并进搜索词的是**同义组里的首选写法**（`searchTagFor`），不是用户原话。
   * 用户说的「颜射」「臀部」「口内射精」是中文，pixiv 上真正通用的标签是「顔射」「お尻」「ごっくん」——
   * 直接拿中文去搜命中率很差。用户原话仍然用来**识别**和**比对作品标签**（`hasTag` 认全组）。
   */
  const searchTags = tags.map(searchTagFor);
  if (searchTags.length) {
    attempts.push(searchTags.join(' '));
    if (searchTags.length > 1) attempts.push(searchTags[0]);
  }
  attempts.push('');

  let pool = [];
  let dropped = 0;
  let used = '';
  for (const extra of attempts) {
    const word = [keyword, extra].filter(Boolean).join(' ').trim();
    let list = [];
    try {
      list = await pixivSearch(word, { count: Math.max(count * 3, 24), mode: safe ? 'safe' : 'all' });
    } catch {
      continue; // 某一路失败就试下一路（别让整个找图挂掉）
    }
    let kept = list;
    if (safe) {
      const keptSafe = list.filter((it) => !isAdultItem(it));
      dropped += list.length - keptSafe.length;
      kept = keptSafe;
    }
    if (kept.length) {
      pool = kept;
      used = extra;
      break;
    }
  }
  const excluded = filterExcluded(pool, exclude);
  const picked = pickByTags(excluded.kept, tags, count);
  return {
    items: picked.items,
    /**
     * ⚠️ **2026-10-10 下午更正语义**：这个字段原来算的是"**哪一次搜索**给出了结果"
     * （带全部标签 / 只带第一个 / 不带标签），而调用方拿它当"**标签命中程度**"打进日志 ——
     * 两者不是一回事，实测就出过一次自相矛盾的日志：
     * `标签【颜射→顔射】 → 标签都没命中（用泛结果），2 条`（**这 2 条恰恰都命中**了颜射，
     * 只是"带标签那次搜索没返回结果、退回不带标签搜"）。
     * 现在 `matched` = `pickByTags()` 的结论（真正的命中程度），
     * "搜索用没用上标签"另给一个 `searchLevel`。
     */
    matched: picked.matched,
    searchLevel: used ? (used === searchTags.join(' ') ? 'all' : 'tag') : 'none',
    dropped,
    /** 被"排除标签"筛掉的数量（用户说不要的，见 `filterExcluded`）。 */
    excluded: excluded.dropped,
    /** 这次**实际用的搜索词**（日志里打出来，方便对账"到底带没带标签"）。 */
    usedWord: [keyword, used].filter(Boolean).join(' '),
  };
}

/**
 * **广泛匹配**的挑选规则（纯函数，可测）：
 * ① 全部标签都命中 → `all`；② 只命中**第一个**标签 → `tag`；
 * ③ 命中任一标签 → `any`；④ 都没命中 → `none`（用泛结果，别让用户空手）。
 */
export function pickByTags(items, tags = [], count = 12) {
  const pool = Array.isArray(items) ? items : [];
  const slice = (arr) => ({ items: arr.slice(0, count), matched: null });
  if (!tags.length) return { items: pool.slice(0, count), matched: 'none' };
  const all = pool.filter((it) => hasAllTags(it, tags));
  if (all.length) return { items: all.slice(0, count), matched: 'all' };
  const first = pool.filter((it) => hasTag(it, tags[0]));
  if (first.length) return { items: first.slice(0, count), matched: 'tag' };
  const any = pool.filter((it) => hasAnyTag(it, tags));
  if (any.length) return { items: any.slice(0, count), matched: 'any' };
  void slice;
  return { items: pool.slice(0, count), matched: 'none' };
}



