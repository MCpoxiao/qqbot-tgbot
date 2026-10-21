/**
 * **联想记忆**（2026-10-20 用户要求）：
 * 「我说过什么，以后提起了她就可以在归档里找到，比如我很久之前提过肚子不适，
 *   今天提了一次她就会说『你之前{什么时候}也肚子疼过』」
 *
 * 为什么放在代码层 ✓：模型**不会主动**去翻旧账 ✗（它连「该翻」都想不到 ✓）；
 * 这一层是**确定性**的 ✓：他这句里出现「部位+症状」⇒ 一定去查 ⇒ 有命中就塞进这一轮提示 ✓。
 *
 * ⚠️ 2026-10-20 第二版：原来是**硬写死的词表** ✗（只有肚子/胃/头/嗓子十来个 ✓），
 *    而归档里他其实还提过**腰、背、脖子、胸、麻、便秘、牙、眼睛** ✓ ⇒ 那些根本查不到 ✗。
 *    现在改成 **部位 × 症状 的组合识别** ✓：任意部位近旁出现症状词就算命中 ✓，不再靠穷举。
 *
 * 成本：纯本地扫 jsonl ✓，**0 token** ✓；没命中话题时连盘都不扫 ✓（先 `detectTopics` 闸门 ✓）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/**
 * 身体部位（**只收不容易误伤的**）。
 * ⚠️ 刻意不含单字「手 / 眼 / 背 / 肩 / 胸 / 耳 / 心」✓：
 *    「手机」「眼镜」「背包」「心累」会把它们全带出来 ✗；改成双字更稳 ✓。
 */
const BODY_PARTS = [
  '肚子', '胃', '肠', '阑尾', '腰', '后背', '胸口', '心口', '脖子', '颈椎', '太阳穴', '脑袋', '头',
  '眼睛', '鼻子', '嗓子', '喉咙', '口腔', '牙龈', '牙', '舌头', '耳朵', '肩膀', '膝盖', '腿', '脚踝', '脚',
  '手指', '手腕', '皮肤',
];

/** 症状词 */
const SYMPTOMS = [
  '疼', '痛', '不舒服', '难受', '晕', '发麻', '麻', '酸', '胀', '抽筋', '肿', '痒', '发炎', '过敏',
  '无力', '使不上劲', '使不上力', '拉肚子', '腹泻', '便秘', '咳嗽', '发烧', '低烧', '失眠', '睡不着',
  '睡不好', '多梦', '耳鸣', '恶心', '想吐', '出血', '木了',
  // 2026-10-20 补：真机归档里有「这贴片看的我眼睛快瞎了」✓ 这类没有标准症状词的表达
  '瞎', '看不清', '模糊', '干涩', '刺痛',
];

/** 只靠症状词就能成立的（不要求出现部位） */
const STANDALONE = [
  '失眠', '睡不着', '睡不好', '便秘', '腹泻', '拉肚子', '过敏', '发炎', '抽筋', '耳鸣', '发烧', '低烧', '多梦',
  // 2026-10-20 补：「手麻了」是真机归档里出现过的话 ✓（单字「手」我刻意不收 ⇒ 这里补具体说法）
  '发麻', '手麻', '脚麻', '腿麻', '胳膊麻',
];

const EMOTION = ['压力大', '心累', '好累啊', '烦死', '崩溃', 'emo', '摆烂', '不想上班', '不想动', '郁闷', '焦虑', '难过', '想哭', '没精神'];
const LIFE = ['熬夜', '通宵', '加班', '迟到', '面试', '出差', '搬家', '体检', '考试', '拔牙', '补牙', '看牙'];

/** 一句话里「部位」和「症状」的距离（字）。太远就不算同一件事 ✓ */
const NEAR = 8;

/**
 * 这句话命中了哪些话题。返回 `[{topic, word}]`；**`word` 一定是他原话里出现过的子串** ✓
 * （`recallPast` 要拿它去 `archive.search` 查 ✓，所以不能返回「身体」这种抽象词 ✗）。
 */
export function detectTopics(text) {
  const t = String(text ?? '');
  if (!t) return [];
  const out = [];
  const seen = new Set();
  const add = (topic, word) => {
    if (!word || seen.has(word)) return;
    seen.add(word);
    out.push({ topic, word });
  };

  // ① 部位 + 症状（互查两个方向 ✓：「腰有点酸」「酸得腰都直不起来」）
  for (const part of BODY_PARTS) {
    const i = t.indexOf(part);
    if (i < 0) continue;
    const win = t.slice(Math.max(0, i - NEAR), i + part.length + NEAR);
    const near = SYMPTOMS.filter((s) => win.includes(s));
    if (!near.length) continue;
    // ⚠️ 2026-10-20：单字部位（头/腰/腿/脚）在归档里到处都是（头条、头一回、点头）✗
    //    ⇒ 原话里出现「部位+症状」连写（头疼 / 腰酸 / 腿麻）时，用**组合词**去搜 ✓（准得多 ✓）
    for (const s of near) {
      if (t.includes(part + s)) add('身体', part + s);
      if (t.includes(s + part)) add('身体', s + part);
    }
    add('身体', part); // 组合词都不成立时退回部位本身 ✓
  }
  // ② 单独症状（「我又失眠了」「便秘」）
  for (const s of STANDALONE) if (t.includes(s)) add('身体', s);
  // ③ 情绪 / 生活短语
  for (const w of EMOTION) if (t.includes(w)) add('情绪', w);
  for (const w of LIFE) if (t.includes(w)) add('生活', w);
  return out;
}

/** 身体类记录里也要有症状词 ✓（否则「肚子」会命中电疗仪、减肥之类的话 ✗） */
const SYMPTOM_GATE = /(疼|痛|不舒服|难受|晕|发烧|低烧|失眠|睡不着|睡不好|拉肚子|腹泻|便秘|咳嗽|感冒|恶心|想吐|酸|胀|麻|抽筋|过敏|发炎|肿|痒|耳鸣|木了|瞎|看不清|模糊|干涩|刺痛)/;

/** 从一段话里摘出**命中词所在的那一小句**（整段塞进提示会很吵 ✓） */
export function pickClause(text, word, max = 60) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const parts = t.split(/[，。！？,!?\n]/).map((s) => s.trim()).filter(Boolean);
  const hit = parts.find((s) => s.includes(word)) ?? t;
  return hit.length > max ? hit.slice(0, max) + '…' : hit;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时间短标签：「10月12日 12:36」（跨年才带年份） */
export function whenLabel(at, now = Date.now()) {
  const d = new Date(at);
  const n = new Date(now);
  const sameYear = d.getFullYear() === n.getFullYear();
  return `${sameYear ? '' : d.getFullYear() + '年'}${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 去归档里翻他**以前**说过的话。
 * @param {object} p
 * @param {object} p.archive  chatlog 实例（有 `search({query,days,limit})` ✓）
 * @param {string} p.text     他这次说的话
 * @param {number} p.days     往前翻多少天（默认 120；归档永久保留，这只是上限）
 * @param {number} p.limit    最多带几条（默认 3）
 * @param {number} p.minAgeMs 至少多久以前（默认 6 小时 ⇒ 不把这一轮/今早的话当「以前」）
 * @param {number} p.now
 * @returns {Array<{at:number, day:string, who:string, text:string, word:string, topic:string}>}
 */
export function recallPast({ archive, text, days = 120, limit = 3, minAgeMs = 6 * 3600 * 1000, now = Date.now() } = {}) {
  if (!archive?.search) return [];
  const hits = detectTopics(text);
  if (!hits.length) return [];
  const out = [];
  const seenDay = new Set();
  for (const h of hits) {
    let rows = [];
    try {
      // ⚠️ 2026-10-20：原来 `limit: 40` ✗ —— `search` 是**从新到旧**取前 N 条，
      //    而「头」在「头条/头一回/点头」里到处都是 ⇒ 目标那条根本轮不到 ✗（实测「起来有点头疼」查不到 ✓）。
      //    归档只有几千条 ⇒ 直接给足上限 ✓，靠后面的闸门筛 ✓。
      rows = archive.search({ query: h.word, days, limit: 5000 }) ?? [];
    } catch {
      rows = [];
    }
    for (const r of rows) {
      if (r.dir !== 'in') continue; // 只翻**他**说的话 ✓
      const body = String(r.text ?? '').trim();
      if (body.length < 4) continue;
      if (h.topic === '身体' && !SYMPTOM_GATE.test(body)) continue;
      if (now - Number(r.at ?? 0) < minAgeMs) continue;
      if (seenDay.has(r.day)) continue;
      seenDay.add(r.day);
      out.push({ at: r.at, day: r.day, who: r.who || '他', text: pickClause(body, h.word), word: h.word, topic: h.topic });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => a.at - b.at).slice(0, limit);
}

/** 把命中拼成一段提示（没命中就返回空字符串 ✓） */
export function formatHint(hits, { now = Date.now() } = {}) {
  if (!Array.isArray(hits) || !hits.length) return '';
  const lines = hits.map((h) => `· ${whenLabel(h.at, now)} 他说：${String(h.text).replace(/\n+/g, ' ').slice(0, 80)}`);
  return (
    '\n\n【联想记忆】他以前也提过类似的事（下面是你自己翻到的旧记录，**是真的**）：\n' +
    lines.join('\n') +
    '\n（**合适就自然带一句**，比如「你 ' + whenLabel(hits[0].at, now) + ' 也说过…」✓；' +
    '**别硬提**、别每次都翻、别把旧话说成新事 ✓。**没合适的就完全别提** ✗。' +
    '旧话是当时的情况，现在未必还这样 —— 只当关心他的理由，别当结论 ✓。）'
  );
}

/**
 * 兜底：不经过 chatlog 实例，直接扫 `D:/小笛记忆/**`（面板/脚本里用）。
 * ⚠️ 只在 chatlog 不可用时才用（没有索引，全量读盘）。
 */
export function recallPastFromDisk({ dir = 'D:/小笛记忆', text, days = 120, limit = 3, now = Date.now() } = {}) {
  if (!existsSync(dir)) return [];
  const hits = detectTopics(text);
  if (!hits.length) return [];
  const pairs = hits.map((h) => ({ word: h.word, topic: h.topic }));
  const out = [];
  const seenDay = new Set();
  let folders = [];
  try {
    folders = readdirSync(dir).filter((d) => /^\d{4}\.\d{2}\.\d{2}$/.test(d)).sort().reverse();
  } catch {
    return [];
  }
  for (const f of folders) {
    const p = dir + '/' + f + '/记忆';
    if (!existsSync(p)) continue;
    let files = [];
    try {
      files = readdirSync(p).filter((x) => x.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const fn of files) {
      for (const line of readFileSync(p + '/' + fn, 'utf8').split('\n')) {
        if (!line) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        if (r.dir !== 'in') continue;
        const body = String(r.text ?? '');
        if (body.length < 4) continue;
        const pair = pairs.find((x) => body.includes(x.word));
        if (!pair) continue;
        if (pair.topic === '身体' && !SYMPTOM_GATE.test(body)) continue;
        if (now - Number(r.at ?? 0) < 6 * 3600 * 1000) continue;
        const day = String(r.day ?? '');
        if (seenDay.has(day)) continue;
        seenDay.add(day);
        out.push({ at: r.at, day, who: r.sender?.nickname || '他', text: pickClause(body, pair.word), word: pair.word, topic: pair.topic });
        if (out.length >= limit) return out.sort((a, b) => a.at - b.at);
      }
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, limit);
}
