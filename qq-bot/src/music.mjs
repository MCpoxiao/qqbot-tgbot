/**
 * QQ 音乐搜索 —— 给「放歌」用。
 *
 * 实测（2026-10-06）：`c.y.qq.com/soso/fcgi-bin/client_search_cp` **不需要登录**，
 * 带 `referer: https://y.qq.com/` 就能用，返回 songmid。
 * 搜「老男孩」第一条正好就是「老男孩 (DJ版)」——用户点名的就是这首。
 *
 * 拿到 songmid 之后，NapCat 的 `music` 消息段（`{type:'music',data:{type:'qq',id:songmid}}`）
 * 就能在 QQ 里发一张可播放的音乐卡片。
 *
 * ⚠️ 注意：**接口返回 retcode:0 只代表 NapCat 收下了，不代表 QQ 里真的显示出来。**
 * 这一点只能靠人在 QQ 里确认，别用返回值当结论。
 */
import { stripHtml, decodeEntities } from './tools.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'user-agent': UA,
  referer: 'https://y.qq.com/',
  'accept-language': 'zh-CN,zh;q=0.9',
};
const TIMEOUT_MS = 12000;

function text(v) {
  return decodeEntities(stripHtml(String(v ?? ''))).trim();
}

/**
 * 从 QQ音乐搜索接口的 JSON 里取歌。
 * 抽成纯函数是为了能用一段固定 JSON 做断言——不然"搜到的对不对"只能靠真去搜一次。
 */
export function parseQQMusic(json, max = 5) {
  const list = json?.data?.song?.list ?? [];
  const out = [];
  for (const s of list) {
    if (out.length >= max) break;
    const songmid = String(s?.songmid ?? '').trim();
    const name = text(s?.songname ?? s?.title);
    if (!songmid || !name) continue;
    out.push({
      songmid,
      name,
      singer: (s?.singer ?? []).map((x) => text(x?.name)).filter(Boolean).join('/'),
      album: text(s?.albumname),
      // 封面可以按 albummid 拼，拼不出来就留空（卡片没封面也能发）
      cover: s?.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : '',
      url: `https://y.qq.com/n/ryqq/songDetail/${songmid}`,
    });
  }
  return out;
}

/** 搜 QQ音乐。返回数组，搜不到就是空数组（由调用方决定怎么跟用户说）。 */
export async function searchQQMusic(keyword, count = 5) {
  const w = String(keyword ?? '').trim();
  if (!w) return [];
  const n = Math.min(10, Math.max(1, Number(count) || 5));
  // ⚠️ **不要加 `new_json=1`**：那会换成另一套字段名（`name`/`mid`/`album`），
  // 而且结果顺序也变（"筷子兄弟"跑到第一条）。经典结构里第一条正好是「老男孩 (DJ版)」。
  const url =
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(w)}` +
    `&format=json&n=${n}&p=1&cr=1&catZhida=1`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseQQMusic(await res.json(), n);
}

/**
 * 按歌名找一首，尽量挑"对味"的那首。
 *
 * 为什么要挑：用户说「老男孩DJ版」时，QQ音乐第一条就是 DJ版；
 * 但用户说「老男孩」时第一条可能不是他要的那个版本。
 * 这里用**关键词命中数**做个小排序，让「DJ」这类限定词真的起作用。
 */
export function pickBestSong(songs, keyword) {
  const kw = String(keyword ?? '').toLowerCase();
  if (!songs.length) return null;
  const scored = songs.map((s, i) => {
    const hay = `${s.name} ${s.singer} ${s.album}`.toLowerCase();
    let score = 0;
    // 把关键词里的词逐个看是否出现在歌名/歌手/专辑里（"DJ版"这种限定词权重最高）
    for (const part of kw.split(/[\s()（）]+/).filter((x) => x.length >= 2)) {
      if (hay.includes(part)) score += 3;
    }
    if (/dj/i.test(kw) && /dj/i.test(hay)) score += 5; // 明确要 DJ 版
    score -= i * 0.1; // 同等条件下保持原顺序
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].s;
}

/** 最长公共子串长度。串都很短，直接 DP，别引库。 */
export function longestCommon(a, b) {
  const A = String(a ?? '');
  const B = String(b ?? '');
  let best = 0;
  let prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j += 1) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

const cleanForMatch = (s) => String(s ?? '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');

/**
 * 这首歌跟关键词**真的**对得上吗？
 *
 * 必须有这道闸：实测搜「zzz不存在的歌名qqq」，QQ音乐返回了「不存在的情人」——
 * **它永远会给点东西**，所以"搜不到"根本不会发生，会放出完全无关的歌。
 * 而用户要的行为是「识别不了就问具体」。
 *
 * 判据是**最长公共子串 ≥ 2 个字**：正常歌名/歌手必然跟关键词有交集，
 * 而一段胡言乱语跟任何歌名都不会有 2 个连续字的巧合。
 */
export function isGoodMatch(song, keyword) {
  if (!song) return false;
  const kw = cleanForMatch(keyword);
  if (kw.length < 2) return false;
  const hay = cleanForMatch(`${song.name}${song.singer}${song.album}`);
  return longestCommon(kw, hay) >= 2;
}

/** 一步到位：搜 + 挑 + 校验。对不上就返回 null（调用方据此问用户要具体歌名）。 */
export async function findSong(keyword, count = 5) {
  try {
    const songs = await searchQQMusic(keyword, count);
    const best = pickBestSong(songs, keyword);
    return isGoodMatch(best, keyword) ? best : null;
  } catch {
    return null;
  }
}
