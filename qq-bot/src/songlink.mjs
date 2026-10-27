/**
 * **歌名 → 播放链接**（2026-10-27 用户要求）。
 *
 * 起因：他问「巴西顺拐舞的歌原名」，她搜了一通**只给了 B站 视频链接** ✗ ——
 * 他接着要「**你把链接给我**」✓，他要的是**能直接点开听歌**的链接 ✓，
 * 不是"歌叫什么"的链接 ✗。
 *
 * 优先级（用户指定）：**QQ音乐 → 网易云 → 酷狗** ✓。
 * 三个站都用**公开搜索接口**（不需要登录 ✓、不需要 cookie ✓）：
 *   · QQ音乐 `c.y.qq.com/soso/fcgi-bin/client_search_cp` → `songmid` → `y.qq.com/n/ryqq/songDetail/<mid>`
 *   · 网易云 `music.163.com/api/search/get/web` → `id` → `music.163.com/song?id=<id>`
 *   · 酷狗   `mobilecdn.kugou.com/api/v3/search/song` → `hash` → `kugou.com/song/#hash=<hash>`
 *
 * 设计要点：
 * - **只回搜到的第一条** ✓（他要的是"给我一个链接"✓，不是候选列表 ✗；候选超过一条时才附一句）；
 * - **每站都带超时** ✓（8 秒 ✓）—— 一个站挂了就直接下一站 ✓，不让他等 ✗；
 * - **找不到就如实说** ✓（"三个站都没搜到"✓），**绝不编** ✗。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TIMEOUT = 9000;

async function getJson(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', ...extraHeaders },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  // 有些接口会包一层 JSONP，去掉外壳再解
  const m = text.match(/^[\w$.]+\s*\(([\s\S]*)\)\s*;?\s*$/);
  return JSON.parse(m ? m[1] : text);
}

/** QQ音乐：搜到的第一条 → 歌曲详情页链接 */
export async function searchQQMusic(keyword) {
  const q = new URLSearchParams({ format: 'json', n: '3', p: '1', w: keyword, cr: '1', g_tk: '5381' });
  const j = await getJson('https://c.y.qq.com/soso/fcgi-bin/client_search_cp?' + q.toString(), {
    referer: 'https://y.qq.com/',
  });
  const list = j?.data?.song?.list ?? [];
  const s = list[0];
  if (!s?.songmid) return null;
  const singers = (s.singer ?? []).map((x) => x.name).filter(Boolean).join('、');
  return {
    site: 'QQ音乐',
    name: String(s.songname ?? '').trim(),
    artist: singers,
    url: 'https://y.qq.com/n/ryqq/songDetail/' + s.songmid,
    more: list.length - 1,
  };
}

/** 网易云：搜到的第一条 → 单曲页链接 */
export async function searchNetease(keyword) {
  const q = new URLSearchParams({ s: keyword, type: '1', limit: '3', offset: '0' });
  const j = await getJson('https://music.163.com/api/search/get/web?' + q.toString(), {
    referer: 'https://music.163.com/',
  });
  const list = j?.result?.songs ?? [];
  const s = list[0];
  if (!s?.id) return null;
  const singers = (s.artists ?? []).map((x) => x.name).filter(Boolean).join('、');
  return {
    site: '网易云',
    name: String(s.name ?? '').trim(),
    artist: singers,
    url: 'https://music.163.com/song?id=' + s.id,
    more: list.length - 1,
  };
}

/** 酷狗：搜到的第一条 → 以 hash 定位的播放页（两个端点，第一个是抖过的那次 ✓） */
export async function searchKugou(keyword) {
  const q = new URLSearchParams({ format: 'json', keyword, page: '1', pagesize: '3', showtype: '1' });
  const endpoints = [
    'https://mobilecdn.kugou.com/api/v3/search/song?' + q.toString(),
    'https://songsearch.kugou.com/song_search_v2?' + new URLSearchParams({ keyword, page: '1', pagesize: '3', platform: 'WebFilter' }).toString(),
  ];
  let lastErr = null;
  for (const url of endpoints) {
    let j;
    try {
      j = await getJson(url, { referer: 'https://www.kugou.com/' });
    } catch (e) {
      lastErr = e;
      continue;
    }
    const list = j?.data?.info ?? j?.data?.lists ?? [];
    const s = list[0];
    if (!s) continue;
    const hash = String(s.hash ?? s.FileHash ?? '');
    if (!hash) continue;
    return {
      site: '酷狗',
      name: String(s.songname ?? s.SongName ?? '').trim(),
      artist: String(s.singername ?? s.SingerName ?? '').trim(),
      url: 'https://www.kugou.com/song/#hash=' + hash,
      more: list.length - 1,
    };
  }
  if (lastErr) throw lastErr;
  return null;
}

/**
 * 主入口：按 **QQ音乐 → 网易云 → 酷狗** 的顺序找，第一个成功就返回 ✓。
 * @param {{song?: string, artist?: string}} args
 * @returns {Promise<string>} 直接给模型看的文字（不抛异常 ✓）
 */
export async function songLink(args = {}) {
  const song = String(args?.song ?? '').trim();
  if (!song) return '要查哪首歌？给个歌名（有歌手更好）。';
  const artist = String(args?.artist ?? '').trim();
  const keyword = artist && !song.includes(artist) ? song + ' ' + artist : song;

  const tries = [
    ['QQ音乐', searchQQMusic],
    ['网易云', searchNetease],
    ['酷狗', searchKugou],
  ];
  const errors = [];
  for (const [label, fn] of tries) {
    try {
      const hit = await fn(keyword);
      if (hit?.url) {
        const title = hit.artist ? hit.name + ' - ' + hit.artist : hit.name;
        const more = hit.more > 0 ? '\n（这条是第一个；要别的版本就说一声）' : '';
        return '找到了（' + label + '）：' + title + '\n' + hit.url + more;
      }
      errors.push(label + '：没结果');
    } catch (e) {
      errors.push(label + '：' + String(e?.message ?? e).slice(0, 40));
    }
  }
  return '三个站都没搜到「' + keyword + '」（' + errors.join(' ｜ ') + '）—— 换个写法（歌手+歌名）再试。';
}
