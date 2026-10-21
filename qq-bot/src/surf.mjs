/**
 * 「自己上网冲浪」—— 随机间隔 + **无聊**触发。
 *
 * 为什么触发条件写在代码里：问模型"你想不想去玩"完全不可靠（它会顺着话头答应，然后什么都不做，
 * 这是今天反复验证过的）。而"无聊"可以用一个**客观量**近似：**主人多久没说话了** ✓。
 * 于是两种触发：攒够一个**随机**间隔，或者他真的太久没来 → 它自己去找点新鲜事。
 */
export function surfGapMs(cfg, rnd = Math.random) {
  const lo = Math.max(1, Number(cfg?.minGapMinutes ?? 40)) * 60000;
  const hi = Math.max(lo, Number(cfg?.maxGapMinutes ?? 150) * 60000);
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

/** 这一轮要不要去冲浪？纯函数，方便测。 */
export function shouldSurf({ cfg, now = Date.now(), lastSurfAt = 0, lastHumanAt = now, sentToday = 0 } = {}) {
  const c = cfg ?? {};
  if (c.enabled === false) return { go: false, why: '已关闭' };
  const hour = new Date(now).getHours();
  if (hour < Number(c.hourFrom ?? 9) || hour >= Number(c.hourTo ?? 23)) return { go: false, why: '安静时段（别半夜发）' };
  if (sentToday >= Number(c.dailyMax ?? 8)) return { go: false, why: `今天已经 ${sentToday} 条了` };
  const sinceSurf = now - lastSurfAt;
  const silent = now - lastHumanAt;
  if (silent >= Number(c.boredAfterMinutes ?? 180) * 60000) {
    const minGap = Number(c.minGapWhenBored ?? 30) * 60000;
    return sinceSurf >= minGap
      ? { go: true, why: `他 ${Math.round(silent / 60000)} 分钟没说话了 —— 有点无聊，去看看有什么新鲜事` }
      : { go: false, why: '刚冲过，等他一会儿' };
  }
  const gap = Number(c.nextGapMs) > 0 ? Number(c.nextGapMs) : surfGapMs(c);
  return sinceSurf >= gap
    ? { go: true, why: `随机间隔到了（${Math.round(gap / 60000)} 分钟）` }
    : { go: false, why: `还早（${Math.round((gap - sinceSurf) / 60000)} 分钟后）` };
}

export function itemKey(x) {
  return `${x?.title ?? ''}|${x?.url ?? ''}`;
}

/**
 * 一条素材**能不能用**：必须有像样的标题。
 *
 * ⚠️ 2026-10-09 用户报「记忆记得有问题 / 他怎么一直卡日历上」，追到底就是这里：
 * `parseSearchLines()` 会把**只有 URL、没有标题**的搜索结果也收进来，
 * `pickFresh()` 又照挑不误 → 她拿到一个**没法描述的空壳**，于是
 * ① 日记写成「自己刷到「」，跟主人说了」（废条目）；
 * ② 它自己**编点东西填空** —— 那阵子的"黄历"就是这么来的。
 * 所以：**没有标题的素材直接不要**（宁可这轮不冲浪，也别让她对着空壳编）。
 */
/**
 * **这些搜出来一律不要**（2026-10-09 实锤）：搜索「今天有什么新鲜事」返回的是
 * 日历网 / 老黄历 / 「历史上的今天」这类页面 —— 她拿到这些素材，聊的自然就是黄历。
 * 用户抱怨了一整天的"刷日历"，**根子在这儿**（我先前误判成"她自己编的段子"，已更正）。
 */
export const JUNK_HOSTS = ['rili.com.cn', 'tthuangli.com', 'huangli', 'lishi.yyxw.com', 'wannianli', 'lunar'];
export const JUNK_TITLE = /黄历|农历|日历|万年历|历史上的今天|节气|宜忌|值神/;

export function isJunkItem(it) {
  const url = String(it?.url ?? '');
  const title = String(it?.title ?? '');
  if (JUNK_HOSTS.some((h) => url.includes(h))) return true;
  return JUNK_TITLE.test(title);
}

export function isUsableItem(it) {
  if (isJunkItem(it)) return false; // 黄历/日历类，见上
  const title = String(it?.title ?? '').trim();
  return title.length >= 4;
}

/** 挑一条**没发过**的、且**可用**的（标题或链接任一见过就跳过）→ 不天天重复同一件事。 */
export function pickFresh(items, seen = []) {
  const seenSet = new Set((seen ?? []).map(String));
  for (const it of items ?? []) {
    if (!it) continue;
    if (!isUsableItem(it)) continue; // 空标题的空壳：见 isUsableItem 的说明
    if (seenSet.has(itemKey(it)) || seenSet.has(String(it.url ?? '')) || seenSet.has(String(it.title ?? ''))) continue;
    return it;
  }
  return null;
}

/**
 * 把工具返回的那段文本解析成 {title,url}。
 * 为什么在这侧解析：tools.mjs 的搜索类工具一律返回"给模型看的字符串"（项目约定），
 * 而冲浪需要能去重的结构化条目 —— 在这边解析最小、可测，也不用去动别人的签名。
 *
 * ⚠️ **标题空/太短的直接丢掉**（2026-10-09）：搜索结果的排版有时只有一行 URL，
 * 解析出来标题是空的；那种条目她没法讲，只会逼它编。
 */
export function parseSearchLines(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  const push = (title, url) => {
    const t = String(title ?? '').replace(/^\s*\d+[.、)]\s*/, '').replace(/UP[:：].*$/, '').trim().slice(0, 80);
    if (t.length < 4) return; // 只有链接、没标题 → 不是能用的素材
    const it = { title: t, url };
    if (isJunkItem(it)) return; // 黄历/日历类直接丢
    if (!out.some((x) => x.url === url)) out.push(it);
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/https?:\/\/[^\s）)]+/);
    if (!m) continue;
    const url = m[0];
    // 形态 A：标题和链接**在同一行**（「1. 某站停运  https://…」）
    const sameLine = line.replace(/^\s*\d+[.、)]\s*/, '').replace(url, '').trim();
    if (sameLine.length >= 4) {
      push(sameLine, url);
      continue;
    }
    /**
     * 形态 B：**标题在上一行、链接单独一行**（实测搜索工具就是这么排的）：
     *   1. 日历网
     *        https://www.rili.com.cn/
     *        14 小时之前 · 日历网提供在线日历查询…
     * 之前只认形态 A → 标题全是空 → **一条都解析不出来**（这就是"源一直取不到东西"的一半原因）。
     */
    let title = '';
    for (let k = i - 1; k >= 0 && k >= i - 3; k -= 1) {
      const cand = lines[k].replace(/^\s*\d+[.、)]\s*/, '').trim();
      if (!cand || /https?:\/\//.test(cand)) continue;
      title = cand;
      break;
    }
    push(title, url);
  }
  return out;
}

/**
 * **新闻站降权**（2026-10-12 加，起因是用户问「为什么卡新闻了」）。
 *
 * 查到的实情：取材池只有两个源 —— B站热门（12 条）＋一次网络搜索（8 条），
 * 而**搜索的查询词写死成「今日热点新闻」** ✗ ⇒ 返回的几乎全是新闻站
 * （当天实测 9 次"已发"里 7 次是 头条热榜/网易新闻/央视网/新浪新闻/人民网）。
 * 更糟的是：**视频要过"看懂"那道审、新闻不用** ⇒ 视频常被审掉，新闻就直接发出去了。
 *
 * 修法（**降权，不禁用** —— 偶尔来条热点也合理）：把域名命中 `avoidDomains` 的条目
 * **排到后面**，于是 `pickFresh()` 会优先拿到视频/别的来源；没有别的可发时才轮到新闻。
 * 纯函数，可单测。
 */
export function orderItems(items, { avoidDomains = [] } = {}) {
  const bad = (avoidDomains ?? []).map((d) => String(d).toLowerCase()).filter(Boolean);
  const isNews = (it) => {
    const u = String(it?.url ?? '').toLowerCase();
    return bad.some((d) => u.includes(d));
  };
  const list = [...(items ?? [])];
  return [...list.filter((it) => !isNews(it)), ...list.filter(isNews)];
}

/**
 * **轮换搜索查询词**（2026-10-12 加）。原来写死 `'今日热点新闻'` ⇒ 素材永远是新闻。
 * 现在从一组词里按时间轮换（可配置）：既保留"知道今天发生了什么"，也掺进更有意思的题材。
 */
export function pickQuery(queries, now = Date.now()) {
  const list = (queries ?? []).map((q) => String(q ?? '').trim()).filter(Boolean);
  if (!list.length) return '今日热点新闻';
  // 10 分钟粒度轮换 —— 同一次冲浪里多次调用拿到同一个词（不会一会儿东一会儿西）
  return list[Math.floor(now / (10 * 60 * 1000)) % list.length];
}
