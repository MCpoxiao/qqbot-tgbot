/**
 * 小笛的长期记忆：档案（事实） + 日记（情节） + 待审批草稿。
 *
 * 三条硬规矩（都是 2026-10-07 那天用血换来的）：
 *
 * 1. **模型只负责"提取"，写入由代码做。** 它没有元认知（不知道自己记没记住、
 *    也不会去核），所以"要不要记、记到哪"必须落在代码里；模型只从对话原文里挑句子。
 * 2. **必须带时效。** 事实分「长期」（偏好、称呼、习惯 —— 不过期）和「近期」
 *    （在准备考试、这几天在减肥 —— 过了 nearTtlDays 自动失效）。不然半个月后
 *    它还在拿旧状态说话，比没记忆更糟。
 * 3. **先审后记。** 整理出来的东西**先发主人过一眼**，他点头才落盘；不回复就不记。
 *    宁可少记，也不要记错 —— 错事实进档案会污染之后每一次对话，而它自己**不会发现**。
 *
 * 文件只有一个 JSON（`cfg.memory.file`）：
 *   { facts: { <uid>: [ {id, text, kind, at, until?, source} ] },
 *     diary: { <uid>: { 'YYYY-MM-DD': '今天…' } },
 *     drafts:{ <uid>: { at, items:[{type,text,kind}] } },
 *     cursor:{ <uid>: 已整理到第几条对话 } }
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_FACTS = 40; // 档案上限：超了先丢最老的「近期」，长期的不动
const DRAFT_MAX_ITEMS = 6;

/**
 * 本地日历日（**不是 UTC**）。
 * 踩过：一开始用 `toISOString().slice(0,10)`，那是 UTC —— 在 UTC+8 的凌晨会写成**前一天**，
 * 日记就会串日期。记忆里的日期错了，比没有日期更糟（它会拿错日期跟你对账）。
 */
export function localDay(ts = Date.now(), timezone = 'Asia/Shanghai') {
  try {
    // en-CA 的输出就是 YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function dayOf(ts) {
  return localDay(ts);
}

/**
 * 时间戳（本地时区，到分钟）：**注入给模型看的那种**。
 * 为什么记忆必须带它：没有时间锚点，它就分不清「昨天说的」和「两周前说的」——
 * 而「近期」这种事实的全部意义就在于"什么时候记的、还算不算数"。
 */
export function stamp(ts) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(new Date(ts))
      .replace(/\//g, '-');
  } catch {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** 剥掉标点和空白，用于"这句话在原文里有没有依据"的比对。 */
export function squash(s) {
  return String(s ?? '').replace(/[\s，。！？、,.!?：:；;“”"'（）()【】\[\]…—-]/g, '');
}

/**
 * 防编造：这条事实有没有**在原文里出现过**？
 * 判据取"至少一个 4 字连续片段能在原文里找到" —— 很土，但不用分词、不看语义，
 * 对"凭空造一条"足够敏感。代价是**改写太多的真事实也会被丢**，
 * 而这里宁可少记（少记只是没用，记错是污染）。
 */
export function hasSupport(factText, source) {
  const f = squash(factText);
  const s = squash(source);
  if (!f) return false;
  if (!s) return false;
  if (f.length < 4) return s.includes(f);
  for (let i = 0; i + 4 <= f.length; i += 1) {
    if (s.includes(f.slice(i, i + 4))) return true;
  }
  return false;
}

/**
 * **把"支撑这条事实的那几句原文"找出来**（2026-10-13 加，修一个真 bug）。
 *
 * ## 为什么需要它
 * 旧代码的 source 是 `String(source).slice(0, 200)` ✗ —— 也就是**整段窗口原文的前 200 字**。
 * 后果（用户 2026-10-13 报「记忆里的 source 全是错的」）：
 * **40 条事实的 source 长度全部恰好 200**，而其中 **38 条的关键词一个都不在自己挂的 source 里** ✗✗
 * （比如「选健身课是因为羽毛球课没选上」挂着「早？诶？早什么早呀…」的开头）。
 * 更糟的是**校验用的是全文**（`hasSupport(t, source)` ✓）—— 于是"验的是全文、存的是前 200 字"，
 * 防编造的闸门形同虚设：**存进档案的那份证据根本证明不了这条事实** ✗。
 *
 * ## 做法
 * 把 source 按行/句切开，逐段算"跟事实的 4 字重叠数"（与 `hasSupport` 同一套判据 ✓），
 * 返回**重叠最多**的那一段（最多 2 段、合计 ≤300 字）。
 * 找不到任何重叠 ⇒ 返回 `''` ⇒ **这条事实不该入库**（调用方据此丢弃 ✓）。
 *
 * ⇒ 由此得到一个**可断言的不变量**：入库的每条事实都满足 `hasSupport(text, source) === true` ✓。
 */
export function findSupport(factText, source, { maxSegments = 2, maxChars = 300 } = {}) {
  const f = squash(factText);
  const raw = String(source ?? '');
  if (!f || !raw.trim()) return '';
  // 按行 + 中文句末标点切段（保留顺序，句子太碎的再合并）
  const segs = raw
    .split(/\r?\n/)
    .flatMap((l) => l.split(/(?<=[。！？!?；;])/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const score = (seg) => {
    const s = squash(seg);
    let n = 0;
    for (let i = 0; i + 4 <= f.length; i += 1) if (s.includes(f.slice(i, i + 4))) n += 1;
    return n;
  };
  const scored = segs.map((s, i) => ({ s, i, n: score(s) })).filter((x) => x.n > 0);
  if (!scored.length) return '';
  const top = scored.sort((a, b) => b.n - a.n || a.i - b.i).slice(0, Math.max(1, maxSegments)).sort((a, b) => a.i - b.i);
  let out = top.map((x) => x.s).join(' ');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}

export class Memory {
  constructor(cfg) {
    this.cfg = cfg?.memory ?? {};
    this.file = this.cfg.file ?? 'logs/memory.json';
    this.data = { facts: {}, diary: {}, drafts: {}, cursor: {} };
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return this;
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
                  /**
           * ⚠️ **不能只挑认识的键**（2026-10-09 修，代价是丢过一次数据）：
           * 原来只重建 facts/diary/drafts/cursor，而 save() 写的是**整个 this.data**
           * → 文件里别的键（surf=「冲浪发过哪些」、auto=「整理到哪/指纹」）**一读一写就被抹掉**，
           * 重启即失忆（冲浪会重复发同样素材、记忆会重复整理）。
           * 现在：先铺默认值，再用文件里的键**全量合并** —— 以后新增的键也不会被吃掉。
           */
          this.data = { facts: {}, diary: {}, drafts: {}, cursor: {}, surf: {}, auto: {}, ...raw };
      }
    } catch {
      // 坏文件就当没记忆：宁可失忆，也不要把机器人弄挂
    }
    return this;
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 1), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** 未过期的事实（`near` 到期就不算了，但不删，留着能回看）。 */
  facts(userId, now = Date.now()) {
    const list = this.data.facts[String(userId)] ?? [];
    return list.filter((f) => !f.until || f.until > now);
  }

  addFact(userId, { text, kind = 'long', who = 'master', source = '', now = Date.now() }) {
    const t = String(text ?? '').trim();
    if (!t) return { ok: false, error: '空事实' };
    const uid = String(userId);
    const list = (this.data.facts[uid] ??= []);
    if (list.some((f) => squash(f.text) === squash(t))) return { ok: false, error: '已经有了' };
    const ttl = Number(this.cfg.nearTtlDays ?? 14) * 86400000;
    const item = {
      id: `F${now.toString(36)}${Math.floor(Math.random() * 1000)}`,
      text: t,
      kind: kind === 'near' ? 'near' : 'long',
      who: who === 'self' ? 'self' : 'master', // self = 它自己想记的（自己的心情/你俩之间的事）
      at: now,
      /**
       * ⚠️ **200 → 400**（2026-10-13）：以前这里把 source 截成 200 字 ✗，
       * 而 200 字只够装"整段原文的开头" —— 于是存档里的证据证明不了事实（用户报的
       * 「source 全是错的」）。现在 source 由 `findSupport()` 给出**定位好的片段**（≤300 字 ✓），
       * 这里只是兜底限长，不再当"截取证据"的手段 ✗。
       */
      source: String(source ?? '').slice(0, 400),
    };
    if (item.kind === 'near') item.until = now + ttl;
    list.push(item);
    if (list.length > MAX_FACTS) {
      const idx = list.findIndex((f) => f.kind === 'near');
      list.splice(idx >= 0 ? idx : 0, 1);
    }
    this.save();
    return { ok: true, item };
  }

  dropFact(userId, idOrIndex) {
    const list = this.data.facts[String(userId)] ?? [];
    const key = String(idOrIndex);
    const idx = /^\d+$/.test(key) ? Number(key) - 1 : list.findIndex((f) => f.id === key);
    if (idx < 0 || idx >= list.length) return { ok: false, error: '没有这一条' };
    const [gone] = list.splice(idx, 1);
    this.save();
    return { ok: true, item: gone };
  }

  writeDiary(userId, date, text) {
    const uid = String(userId);
    const day = date ?? dayOf(Date.now());
    const t = String(text ?? '').trim();
    if (!t) return { ok: false };
    this.data.diary[uid] ??= {};
    this.data.diary[uid][day] = t;
    this.save();
    return { ok: true };
  }

  /** 最近 n 天的日记（新→旧）。 */
  diary(userId, days = 2) {
    const all = this.data.diary[String(userId)] ?? {};
    return Object.keys(all)
      .sort()
      .reverse()
      .slice(0, Math.max(1, days))
      .map((k) => ({ date: k, text: all[k] }));
  }

  setDraft(userId, items, now = Date.now()) {
    this.data.drafts[String(userId)] = { at: now, items: items.slice(0, DRAFT_MAX_ITEMS) };
    this.save();
  }

  draft(userId, now = Date.now()) {
    const d = this.data.drafts[String(userId)];
    if (!d) return null;
    const ttl = Number(this.cfg.draftTtlHours ?? 12) * 3600000;
    if (now - d.at > ttl) return null; // 超时没人审就当没提过
    return d;
  }

  clearDraft(userId) {
    delete this.data.drafts[String(userId)];
    this.save();
  }

  cursor(userId) {
    return Number(this.data.cursor[String(userId)] ?? 0);
  }

  setCursor(userId, n) {
    this.data.cursor[String(userId)] = Number(n) || 0;
    this.save();
  }

  /**
   * 「上次整理到哪」的**指纹**（2026-10-09 补，用户要求"bug 修彻底"）。
   *
   * 为什么不能只靠游标：`consolidate()` 里游标被 `Math.min(cursor, 长度−40)` **夹住** ——
   * 它永远指在"倒数第 40 条"，于是每次整理看到的都是**同一批 40 条**
   * （实测 06:43 / 09:08 / 10:50 / 10:57 / 12:30 五次日志全是"新对话 40 条"，草稿大量重叠）。
   * 重复挖有去重兜底，但**每挖一次都可能新造一批错事实**（10-09 那三条假事实就是这么来的）。
   *
   * 指纹 = 「这一窗口多少条 + 最后一条长什么样」：一样就说明**没有新对话**，直接跳过。
   */
  tailMark(userId) {
    return String(this.data.auto?.[`tail:${String(userId)}`] ?? '');
  }

  setTailMark(userId, mark) {
    this.data.auto = this.data.auto ?? {};
    this.data.auto[`tail:${String(userId)}`] = String(mark ?? '');
    this.save();
  }

  /**
   * 拼**注入**给模型的那一段（放提示词最末尾）。
   * 预算卡死 —— 记忆抢戏比没记忆更糟：人格会被一堆事实淹掉。
   */
  injection(userId, now = Date.now()) {
    if (this.cfg.enabled === false) return '';
    const budget = Number(this.cfg.maxInjectChars ?? 1200);
    const lines = [];
    const facts = this.facts(userId, now);
    if (facts.length) {
      /**
       * 时间戳只给**用得上的粒度**：
       * · 长期（偏好/习惯）—— 只要日期，用来判断"哪条更新"；精确到分钟是纯浪费字节
       *   （注入预算只有一千多字，省下来的都是内容）；
       * · 近期 —— 日期 + **有效到哪天**，这才是真有用的那一半（"别拿过期状态说话"）；
       * · 日记按天存，日期就是它的键，不用额外时间戳。
       * ⚠️ 方括号里是**记录时间**，不是事情发生的时间 —— 别混（表头里写明了）。
       */
      lines.push('【你记得他的事】长期=一直算数；近期=过一阵就不算数了。方括号里是**记下的日期**，近期还写了有效到哪天');
      for (const f of facts.filter((x) => x.who !== 'self')) {
        const tag = f.kind === 'near' ? '近期' : '长期';
        const until = f.until ? `，有效到 ${localDay(f.until)}` : '';
        lines.push(`· [${tag}·${localDay(f.at)}${until}] ${f.text}`);
      }
    }
    const selfFacts = facts.filter((x) => x.who === 'self');
    if (selfFacts.length) {
      lines.push('【你自己记得的事】这些不是关于他的资料，是**你自己**想记的（当时的心情、你俩之间的事）。可以自然地提，但别硬拎出来说');
      for (const f of selfFacts) lines.push(`· [${localDay(f.at)}] ${f.text}`);
    }
    const diary = this.diary(userId, Number(this.cfg.diaryDays ?? 2));
    if (diary.length) {
      lines.push('【最近的事】');
      const today = localDay(now);
      for (const d of diary) lines.push(`· ${d.date}${d.date === today ? '（今天）' : ''}：${d.text}`);
    }
    const draft = this.draft(userId, now);
    if (draft) {
      lines.push(
        '【待审批的记忆草稿】下面这些是我整理出来、**还一条都没记下**的。他这句话如果是在答复它' +
          '（同意 / 删某条 / 改某条），就调用 memory_review 去落实，**别自己说「我记下了」**：',
      );
      draft.items.forEach((it, i) => {
        const tag = it.type === 'diary' ? '日记' : it.kind === 'near' ? '近期' : '长期';
        lines.push(`${i + 1}. [${tag}] ${it.text}`);
      });
    }
    if (!lines.length) return '';
    let text = lines.join('\n');
    if (text.length > budget) text = `${text.slice(0, budget)}…（太长了，截断）`;
    return `\n\n${text}`;
  }
}

/** 整理任务的提示词：**只喂对话原文**，输出固定格式，方便代码解析。 */
/**
 * 去掉**机器注入的块**，只留真正的对话内容。
 *
 * 为什么必须有（2026-10-09 用户报「记忆记得有问题」）：整理长期记忆时把助理那几行也喂了进去，
 * 而助理那几行里混着**工具结果与注入块** —— 实测产出了这样的"事实"：
 *
 *   他正在解决桌宠素材找图重复的问题      ← 真相是：那一行来自**截图的窗口标题**
 *                                          「找图重复怎么解决 — DeepSeek Harness」，
 *                                          是**我这边的会话名**，跟他一点关系都没有
 *   他想看日历网那种万年历、黄历、节气宜忌 ← 纯脑补（他明明在抱怨她老刷黄历）
 *
 * 所以喂给提取模型之前，先把这些方括号注入块整段删掉。
 */
export function stripInjectedBlocks(text) {
  return String(text ?? '')
    .replace(/【图里的内容】[\s\S]*?(?=\n【|\n[^\n]*$|$)/g, '')
    .replace(/【以图搜图】[^\n]*/g, '')
    .replace(/【B站视频内容[^】]*】[\s\S]*?(?=\n【|$)/g, '')
    .replace(/【系统】[\s\S]*$/m, '')
    .replace(/【(当前对话对象|本轮语气|你们的关系|你记得他的事|你自己记得的事|最近的事|待审批的记忆草稿|梗库|这台电脑|定时提醒|账号上的三件事)[^】]*】[\s\S]*?(?=\n【|$)/g, '')
    .replace(/\[\[[^\]]{0,200}\]\]/g, '')
    .replace(/（认人要有把握[^）]*）/g, '')
    .trim();
}

export function buildConsolidationAsk({ turns, existing = [], date }) {
  const convo = turns
    .map((t) => {
      /**
       * ⚠️ **她的行要逐行标明"这不是证据"**（2026-10-09）：光删注入块不够 ——
       * 实测她是把窗口标题写进**自己的句子**里的（「窗口名叫「找图重复怎么解决 — DeepSeek Harness」」），
       * 提取模型于是把它记成了"他在解决找图重复的问题"。标注比一句总则更难被忽略。
       */
      const who = t.role === 'assistant' ? '小笛（她的原话，**只是上下文，不算他说过的事**）' : '主人';
      const body = t.role === 'assistant' ? stripInjectedBlocks(t.content) : String(t.content ?? '');
      return `${who}：${body.slice(0, 300)}`;
    })
    .filter((line) => line.replace(/^[^：]*：/, '').trim())
    .join('\n');
  const known = existing.length ? existing.map((f) => `· ${f.text}`).join('\n') : '（还没有）';
  return [
    '你在帮一个聊天机器人整理**长期记忆**。下面是它和主人的真实对话，以及它已经记住的事。',
    '',
    '【已经记住的】',
    known,
    '',
    '【要整理的对话】',
    convo,
    '',
    '要求：',
    '1. 只记**主人那几行**里他明确说过、做过的事：偏好、习惯、称呼、正在做的事、明确的要求。',
    '   ⚠️ **「小笛」那几行只是上下文，不是证据**：她自己说的话、她工具跑出来的结果',
    '   （截图里的窗口标题/网页标题/图里认出的东西、搜索到的条目）**都绝不能当成"他做过的事"** ——',
    '   2026-10-09 就出过这种错：把截图里的窗口名「找图重复怎么解决」记成了"他在解决找图重复的问题"。',
    '   **不许推测、不许脑补**；拿不准就不写。',
    '2. 每条一句话，**尽量用他原话里的词**（别改写成你的说法）。',
    '3. 判时效：「长期」= 偏好/习惯/称呼这种一直算数的；「近期」= 在准备考试、这几天在减肥这种过一阵就不算的。',
    '4. 已经记住的不重复写。没有值得记的就什么都别输出。',
    '5. **你也可以记「你自己觉得有意义的」**：当时的心情、你俩之间发生的事、你自己的决定或偏好。',
    '   这类用「自己:」开头（时长判断同上）。别写空话，一条就行，最多两条。',
    '6. 严格按下面格式，一行一条，不要别的话（日记最多一行）：',
    '自己: 长期 | 今天他说我凶，其实我挺高兴的',
    '事实: 长期 | 他不喜欢被叫小主人',
    '事实: 近期 | 他这周在背单词，每天 20 个',
    `日记: ${date} 今天他…（两三句：发生了什么、他状态怎么样）`,
  ].join('\n');
}

/** 解析整理结果 → { facts:[{text,kind,supported}], diary }。 */
export function parseConsolidation(text, { source = '' } = {}) {
  const facts = [];
  let diary = '';
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim().replace(/^[-*·]\s*/, '');
    const m = line.match(/^(?:事实|Fact)\s*[:：]\s*(长期|近期|long|near)\s*[|｜]\s*(.+)$/);
    if (m) {
      const t = m[2].trim();
      if (t) {
        facts.push({
          text: t,
          kind: /近期|near/.test(m[1]) ? 'near' : 'long',
          supported: hasSupport(t, source),
          /**
           * ⚠️ **存"支撑它的那几句原文"**（2026-10-13）：以前是整段窗口的前 200 字 ✗，
           * 结果存档里的 source 证明不了这条事实（用户报「source 全是错的」）。
           * 现在把关键词在原文里**定位到具体那几句** ✓ —— 一份能核对得上的证据 ✓。
           */
          excerpt: findSupport(t, source),
        });
      }
      continue;
    }
    const s2 = line.match(/^(?:自己|Self)\s*[:：]\s*(长期|近期|long|near)\s*[|｜]\s*(.+)$/);
    if (s2) {
      const t2 = s2[2].trim();
      /**
       * 自我记忆**不查原文依据**：那是它的主观（要求逐字重叠就一条都留不下）。
       * 真正的闸是「主人审批 + 面板可删」，见 memory.mjs 开头第 3 条。
       * ⚠️ **2026-10-13 补**：它也没有 `excerpt` —— 所以下面 `draftFrom` 里
       * **不能把"必须有片段"这条要求套到自我记忆上** ✗（自测当场抓到我把它们全丢了 ✗）。
       * 自我记忆的 source 存**窗口末尾的近期上下文**（不是证据，是"当时在聊什么"✓）。
       */
      if (t2 && t2.length <= 60) {
        facts.push({ text: t2, kind: /近期|near/.test(s2[1]) ? 'near' : 'long', who: 'self', supported: true, excerpt: '' });
      }
      continue;
    }
    const d = line.match(/^(?:日记|Diary)\s*[:：]\s*(.+)$/);
    if (d && !diary) diary = d[1].trim();
  }
  return { facts, diary };
}

/** 把草稿拼成**自然对话**（发给他审批用的），不是表单。 */
export function formatDraft(items) {
  const lines = items.map((it, i) => {
    const tag =
      it.type === 'diary' ? '今天的事' : it.who === 'self' ? '我自己想记的' : it.kind === 'near' ? '近期' : '长期';
    return `${i + 1}. （${tag}）${it.text}`;
  });
  return (
    '我今天想记下这几件事，你过一眼？\n\n' +
    lines.join('\n') +
    '\n\n有不对的、或者不想让我记的，说一声就行——**你不回我就不记**。'
  );
}

/* ------------------------------ 工具（审批用） ------------------------------ */

export const MEMORY_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'memory_review',
      description:
        '落实主人对「待审批记忆草稿」的答复。他说「都行/可以/记吧」就 approve_all=true；他挑着同意就填 keep；他说「第 2 条不要」就填 drop；他要改说法就填 edits。落实完草稿就作废，**不要重复调用**。',
      parameters: {
        type: 'object',
        properties: {
          approve_all: { type: 'boolean', description: '他整体同意了' },
          keep: { type: 'array', items: { type: 'integer' }, description: '同意的条目序号（从 1 开始）' },
          drop: { type: 'array', items: { type: 'integer' }, description: '不要记的条目序号' },
          edits: {
            type: 'array',
            description: '要改写的条目',
            items: {
              type: 'object',
              properties: { index: { type: 'integer' }, text: { type: 'string' } },
              required: ['index', 'text'],
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
];

export const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOL_DEFS.map((d) => d.function.name));

/** 记忆工具同样**只给主人私聊**（档案是他私人的东西）。 */
export function memoryAllowed(cfg, ctx) {
  if (cfg?.memory?.enabled === false) return false;
  return ctx?.isPrivate === true && ctx?.isMaster === true;
}

export function runMemoryTool(cfg, name, args, ctx) {
  if (!memoryAllowed(cfg, ctx)) return '拒绝：记忆只对主人的私聊开放。';
  const mem = ctx?.memory;
  if (!mem) return '错误：这一轮没有挂上记忆库。';
  if (name !== 'memory_review') return `错误：不认识的记忆工具 ${name}。`;
  const uid = String(ctx?.userId ?? ctx?.who ?? '');
  const draft = mem.draft(uid);
  if (!draft) return '现在没有待审批的草稿（可能已经处理过，或者超时作废了）。';

  const a = args ?? {};
  const edits = Array.isArray(a.edits) ? a.edits : [];
  const keepSet = new Set(a.approve_all === true ? draft.items.map((_, i) => i + 1) : (a.keep ?? []).map(Number));
  const dropSet = new Set((a.drop ?? []).map(Number));
  for (const e of edits) if (e && Number.isFinite(Number(e.index))) keepSet.add(Number(e.index));

  const saved = [];
  const skipped = [];
  draft.items.forEach((it, i) => {
    const n = i + 1;
    if (dropSet.has(n) || !keepSet.has(n)) {
      skipped.push(n);
      return;
    }
    const edit = edits.find((e) => Number(e?.index) === n);
    const text = edit ? String(edit.text) : it.text;
    if (it.type === 'diary') {
      mem.writeDiary(uid, undefined, text);
      saved.push(`日记：${text.slice(0, 40)}`);
      return;
    }
    const res = mem.addFact(uid, { text, kind: it.kind, who: it.who ?? 'master', source: it.source ?? '' });
    saved.push(res.ok ? text : `${text}（${res.error}）`);
  });
  mem.clearDraft(uid);
  mem.setCursor(uid, Number(ctx?.consolidatedTurns ?? mem.cursor(uid)));
  if (!saved.length) return `落实了：这些都没记（丢掉第 ${skipped.join('、')} 条）。`;
  return `落实了：记下 ${saved.length} 条${skipped.length ? `，丢掉第 ${skipped.join('、')} 条` : ''}。\n${saved.map((s) => `· ${s}`).join('\n')}`;
}

/**
 * **他这句是不是"批准那份草稿"？**（2026-10-13 加，纯函数便于离线自测）
 *
 * 背景：落盘原来**完全靠模型想起来调 `memory_review`** ✗ —— 实证它没调（他 22:41 说「记」，
 * 22:42 日志 `模型说记下了，但没调 memory_review —— 档案没动` ✗，而她还回「好，记下了」✗）。
 * 所以改成**代码判批准、代码落盘** ✓。
 *
 * 判据（**故意保守**，宁可漏判交给模型，也不要误判把他的"第 2 条去掉"当成整体批准 ✗）：
 *   · 短句（≤12 字）：长句里通常夹着别的要求 ✗；
 *   · 命中批准词：记/记吧/记下/都记/存/好/行/可以/都行/没问题/批准/落实…；
 *   · **排除**选择性或否定：第X条 / 去掉 / 删 / 不要 / 改 / 换 / 别记 / 算了 / 重来 ✗。
 */
export function isDraftApproval(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 12) return false;
  if (/第\s*[0-9一二三四五六七八九十]|去掉|删|不要|别记|改|换|算了|重来|再想想/.test(t)) return false;
  return /^(记|记吧|记下|记好了|都记|都记下|存|存吧|好|好的|好呀|行|行吧|可以|都行|没问题|准|批准|落实|就这么记|就这样记|按这个记|照这个记)[!！。~～\s]*$/.test(t);
}

/** 整理一次：从"还没整理过的对话"里提取，产出**待审批草稿**。纯函数化以便测试。 */
export function draftFrom({ rawText, turns, existing, date, source }) {
  const parsed = parseConsolidation(rawText, { source });
  const items = [];
  for (const f of parsed.facts) {
    /**
     * ⚠️ **两道闸都要过**（2026-10-13 改）：
     *   ① `supported`：原文里找得到依据（旧有 ✓）；
     *   ② `excerpt` **非空**：能把依据**定位到具体那几句** ✓ ——
     *      否则存进档案的 source 证明不了这条事实（就是用户报的「source 全是错的」✗）。
     * 以前只查 ①，存的时候却写"整段原文的前 200 字" ✗ —— 于是 40 条里 38 条对不上 ✗✗。
     */
    // ⚠️ **分两种人**（2026-10-13，自测当场抓到我把"她自己想记的"全丢了 ✗）
    const isSelf = f.who === 'self';
    if (isSelf) {
      // 她自己想记的：那是它的主观，**不查原文依据**（要求逐字重叠就一条都留不下 ✓）。
      // source 存**窗口末尾的近期上下文**（不是证据，是"当时在聊什么"✓）。
      items.push({ type: 'fact', text: f.text, kind: f.kind, who: 'self', source: String(source ?? '').slice(-240) });
      continue;
    }
    if (!f.supported || !f.excerpt) continue;
    items.push({ type: 'fact', text: f.text, kind: f.kind, who: f.who ?? 'master', source: f.excerpt });
  }
  if (parsed.diary) {
    // 日记同理：存能对上日记内容的原文片段（找不到就整条不要）
    const dEx = findSupport(parsed.diary, source, { maxSegments: 2, maxChars: 300 });
    if (dEx) items.push({ type: 'diary', text: parsed.diary, kind: 'long', source: dEx });
  }
  return items.slice(0, DRAFT_MAX_ITEMS);
}
