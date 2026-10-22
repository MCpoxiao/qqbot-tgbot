/**
 * 表情包库 + 回复里的发图标记。
 *
 * 设计取舍：**不让模型直接产出图片**，只让它"点单"。
 * 模型在回复里写 [[图:开心]]，程序去本地库里找同名文件发出去。
 * 好处是它不可能发出库里没有的东西——生成的图片 URL 又慢又不可控，
 * 而"点单"这种方式失败时是静默降级（找不到标签就当没写），不会把机器人搞挂。
 *
 * 文件名即标签：stickers/开心.png 的标签就是「开心」。
 * 想要同一个标签多张随机发，用 开心-1.png / 开心-2.png，会归到同一個标签下。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { ROOT } from './config.mjs';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/**
 * 宽松版：任何「长得像发图标记」的残留都算，包括标签超长的畸形标记。
 *
 * 为什么要它：模型偶尔会点一个超长的文件名当标签（真实踩过，
 * 它会照着 39 字符的哈希名点单）。如果正则匹配不到，那段 `[[图:xxx]]`
 * 就会**原样漏进聊天**——用户看到一串乱码。这是最后一道防线。
 */
const MARKER_LOOSE = /\[\[\s*图\s*[:：][^\]\n]{1,600}\]\]/g;

/**
 * 这个标签像不像给人看的？
 *
 * 自动打标签失败的图片会退回「用文件名当标签」，而那些名字通常是
 * `1694307593293` / `a138e2ac7e1c...` / `IMG_20240305` 这种东西。
 * 把它们列给模型等于**往候选里塞垃圾**：它会随机点一个，用户收到一张
 * 毫无关系或者根本解析不出来的表情包。
 */
export function isHumanTag(tag) {
  const t = String(tag ?? '').trim();
  if (!t) return false;
  if (/^\d{8,}$/.test(t)) return false; // 纯长数字（时间戳）
  if (/^[0-9a-f]{16,}$/i.test(t)) return false; // 哈希
  if (/^(IMG_|Camera_|Screenshot_|comment_|heybox_|mmexport|Cache_|mmexport|-)/i.test(t)) return false;
  if (/^\d+_\d+$/.test(t)) return false;
  if (t.length > 8) return false; // 中文标签一般 2-6 字
  return true;
}

/** 视觉模型产出的标签。跑 `--force` 会被整份重写。 */
export const TAGS_VISION_FILE = 'tags.json';
/** 你手动改过的标签。**任何脚本都不会碰它**，优先级高于上面那份。 */
export const TAGS_MANUAL_FILE = 'tags.manual.json';

function readJsonMap(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** 只读「手动改过」的那一份。 */
export function readManualTagMap(dir) {
  return readJsonMap(join(dir, TAGS_MANUAL_FILE));
}

/**
 * 读最终生效的标签表：`{ "文件名.png": "标签" }`。
 *
 * 两份合并、**手动那份优先**。为什么要分开存：
 * 自动打标签会整份重写 `tags.json`（`--force` 时更是全部重来），
 * 如果手改的标签也写在那里，用户辛苦修的几个词会被一次重跑冲掉。
 *
 * 它是**非破坏性**的：不改文件名，只覆盖"标签"的推导结果。
 */
export function readTagMap(dir) {
  return { ...readJsonMap(join(dir, TAGS_VISION_FILE)), ...readManualTagMap(dir) };
}

/**
 * **读"这张图长什么样"的描述表**（2026-10-22 加）。
 *
 * 由 `tools/describe-stickers.mjs` 生成 ✓（每个标签一句 ✓，如"蓝紫耳白猫瞪圆眼，配文兄弟不可以"）。
 * 有了它，模型选图就不只是看标签名 ✗，而是能按**画面**挑 ✓ —— 这是"选得准"的关键一步 ✓。
 * 文件不存在/坏了就返回空对象 ✓（当作没有描述 ✓，绝不因为这张表把回复带崩 ✗）。
 */
export function readDescriptions(dir) {
  try { return readJsonMap(join(dir, '.descriptions.json')); } catch { return {}; }
}

export function loadStickers(dirRel = 'stickers') {
  const dir = resolve(ROOT, dirRel);
  /** @type {Map<string, string[]>} */
  const byTag = new Map();

  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dir, tags: [], count: 0, pick: () => null, tagMap: {} };
  }

  const tagMap = readTagMap(dir);

  for (const ent of entries) {
    if (!ent.isFile() || ent.name.startsWith('.')) continue;
    const ext = extname(ent.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;

    // 优先用 tags.json 里的标签（视觉模型识别的结果）；没有才退回文件名
    const manual = tagMap[ent.name];
    const tag =
      typeof manual === 'string' && manual.trim()
        ? manual.trim()
        : ent.name.slice(0, -ext.length).trim().replace(/[-_ ]\d+$/, '').trim();
    if (!tag) continue;

    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(join(dir, ent.name));
  }

  const tags = [...byTag.keys()].sort();
  let count = 0;
  for (const list of byTag.values()) count += list.length;

  return {
    dir,
    tags,
    count,
    tagMap,
    /** 按标签取一张，同标签多张时随机；找不到返回 null（由调用方静默降级）。 */
    pick(tag) {
      const list = byTag.get(String(tag).trim());
      if (!list || list.length === 0) return null;
      return list[Math.floor(Math.random() * list.length)];
    },
  };
}

/**
 * 第三道防线：**未闭合**的畸形标记。
 * 模型偶尔会输出截断的标记（`[[图:在的` 没有结尾的 `]]`），前两道都匹配不到。
 * 这里只吃掉标记本身，**它后面的话要保留**——所以遇到空白就停，
 * 不做"吃完整行"这种会误伤正文的处理；再加 64 字上限，
 * 防止病态输入（中间没有任何空白）把一整段都吃掉。
 */
const MARKER_UNTERMINATED = /\[\[\s*(?:图|网图|歌|语音)\s*[:：][^\]\s]{0,600}/g;

/**
 * 「宽松版」：任何长得像标记的残留，用于最后清理。
 * 网图和点歌都算——模型偶尔会写出超长/畸形的标记，不能让它们漏进聊天。
 */
const WEB_LOOSE = /\[\[\s*(?:网图|歌|语音)\s*[:：][^\]\n]{1,600}\]\]/g;

/**
 * 统一扫描四种标记：本地表情包 `[[图:标签]]`、网图 `[[网图:URL]]`、
 * 点歌 `[[歌:歌名]]`、语音 `[[语音:要说的话]]`。
 * 一次扫完是为了保持**文档顺序**——分几次扫会把段落先后打乱。
 */
const ANY_MARKER = /\[\[\s*(图|网图|歌|语音)\s*[:：]\s*([^\]\n]{1,600}?)\s*\]\]/g;

/**
 * **不认识的标记**：模型有时会把"工具调用"写成正文里的标记，例如
 * `[[qq_profile_set:personal_note="小笛在，米饭管够"]]`（2026-10-09 实测，**真的发到用户眼前了**）。
 * 它不属于上面四种，于是原样漏进聊天 —— 又丑又让人以为出了错。
 *
 * 这里只吃**名字像工具名/英文标识符**的标记（`[[xxx_yyy: …]]`），
 * 避免误伤正常文本里偶尔出现的方括号；吃掉后由调用方记一条 warn（可观测）。
 */
const UNKNOWN_TOOL_MARKER = /\[\[\s*[A-Za-z][A-Za-z0-9_]{2,40}\s*[:：][^\]\n]{0,600}\]\]/g;
/**
 * **没有冒号**的那种：`[[qq_confirm]]`（2026-10-09 实测又漏了一次，原样发给了用户）。
 * 模型两种写法都会用：带参数的 `[[name:…]]` 和光杆的 `[[name]]`。
 */
const UNKNOWN_TOOL_BARE = /\[\[\s*[A-Za-z][A-Za-z0-9_]{2,40}\s*\]\]/g;
/** 同一个东西的"没写完"版本（模型被截断时会留半个标记）。 */
const UNKNOWN_TOOL_MARKER_OPEN = /\[\[\s*[A-Za-z][A-Za-z0-9_]{2,40}\s*[:：][^\]\s]{0,600}/g;

/** 找出（并去掉）那些"长得像工具调用的标记"，返回 `[清理后的文本, 被吃掉的标记名[]]`。 */
export function stripUnknownToolMarkers(text) {
  const names = [];
  const name = (m) => m.match(/\[\[\s*([A-Za-z][A-Za-z0-9_]{2,40})/)?.[1] ?? '';
  const cleaned = String(text ?? '')
    .replace(UNKNOWN_TOOL_MARKER, (m) => {
      const n = name(m);
      if (n) names.push(n);
      return '';
    })
    .replace(UNKNOWN_TOOL_BARE, (m) => {
      const n = name(m);
      if (n) names.push(n);
      return '';
    });
  return [cleaned, names];
}

/** 把回复里的发图标记全部删掉——图片发不出去时的兜底，保证文字还在。 */
/**
 * **剥掉模型"写成文本的工具调用"**（DeepSeek 的 `DSML` 标记）。
 *
 * 2026-10-19 真机：模型前 4 次工具调用正常 ✓，第 5 次却把调用**当正文**吐出来 ✗：
 * `<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="phone_tap"> <｜｜DSML｜｜ parameter …>`
 * 直接发给了用户 ✓ —— 这类标记**永远不该出现在聊天里** ✗。
 *
 * 规则（保守 ✓）：一旦看见 `DSML` 标记，就认为**从这里往后都是模型的口误** ✓，
 * 整段砍掉 ✓（宁可这条少说一句 ✓，也不要把标记发出去 ✗）。
 * 全角 `｜` 和半角 `|` 都认 ✓（真机上两种都出现过 ✓）。
 */
export function stripToolDsl(text) {
  const s = String(text ?? '');
  if (!/DSML/i.test(s)) return s;
  const i = s.search(/<\s*[|｜]{1,2}\s*DSML/i);
  const cut = i >= 0 ? s.slice(0, i) : s.replace(/<\s*[|｜]{1,2}\s*DSML[^>]*>/gi, '');
  // 再顺手清掉残留的孤立标记（比如句尾只剩一个结束标签）
  return cut.replace(/<\/?\s*[|｜]{1,2}\s*DSML[^>]*>/gi, '').trim();
}

export function stripImageMarkers(text) {
  return stripUnknownToolMarkers(String(text ?? ''))[0]
    .replace(ANY_MARKER, '')
    .replace(MARKER_LOOSE, '')
    .replace(WEB_LOOSE, '')
    .replace(MARKER_UNTERMINATED, '')
    .replace(UNKNOWN_TOOL_MARKER_OPEN, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 把回复拆成「文本段 + 图片段」。标记两侧的文字保留。
 *
 * @param {object} [opts]
 * @param {(url:string)=>boolean} [opts.allowWebImage] 网图放行判定。
 *   **默认一律拒绝**——必须由调用方显式传入（生产里传的是"本次搜到过的地址"）。
 *   没有这道闸，模型可以直接吐任意 URL 让 NapCat 去下载发送。
 * @returns {{segments: Array<object>, unknownTags: string[], rejectedWeb: string[]}}
 */
export function splitReply(text, stickers, {
 allowWebImage } = {}) {
  // ⚠️ 先剥"写成文本的工具调用"（2026-10-19 真机泄漏 ✗：模型把 phone_tap 当正文发出来了）
  //    放在这里是因为 splitReply 是**所有回复**的必经之路 ✓
  text = stripToolDsl(text);
  const segments = [];
  const unknownTags = [];
  const rejectedWeb = [];
  let last = 0;
  // ⚠️ 先把"长得像工具调用的标记"吃掉（`[[qq_profile_set:…]]` 这种），
  //    否则它会**原样发到用户眼前** —— 2026-10-09 实测过一次。
  const [srcRaw, toolMarkers] = stripUnknownToolMarkers(String(text ?? ''));
  const src = srcRaw;
  ANY_MARKER.lastIndex = 0;

  for (const m of src.matchAll(ANY_MARKER)) {
    const before = src.slice(last, m.index);
    if (before.trim()) segments.push({ type: 'text', text: before.trim() });
    last = m.index + m[0].length;

    const kind = m[1];
    const value = m[2].trim();

    if (kind === '网图') {
      if (allowWebImage && /^https?:\/\//i.test(value) && allowWebImage(value)) {
        segments.push({ type: 'webimage', url: value });
      } else {
        rejectedWeb.push(value); // 不在白名单 / 格式不对：丢掉，不报错、不打断
      }
      continue;
    }

    if (kind === '歌') {
      // 点歌：只记歌名，真正的解析交给 bot.mjs（要联网搜 QQ音乐，纯函数里不做 IO）
      if (value) segments.push({ type: 'music', query: value });
      continue;
    }

    if (kind === '语音') {
      // 语音：交给 bot.mjs 去调 QQ 的群 AI 语音（同样不在纯函数里做 IO）
      if (value) segments.push({ type: 'voice', text: value });
      continue;
    }

    const path = stickers.pick(value);
    if (path) segments.push({ type: 'image', tag: value, path });
    else unknownTags.push(value); // 库里没有就丢掉这个标记，不报错、不打断回复
  }

  const rest = src.slice(last);
  if (rest.trim()) segments.push({ type: 'text', text: rest.trim() });
  if (segments.length === 0) segments.push({ type: 'text', text: src.trim() });

  // 合并相邻文本段，并在段落之间补一个换行
  const merged = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (seg.type === 'text' && prev?.type === 'text') prev.text = `${prev.text}\n${seg.text}`;
    else merged.push({ ...seg });
  }

  // 最后一道防线：把任何没被匹配到的畸形标记（比如标签过长）抹掉，
  // 免得 `[[图:xxx]]` 原样漏进聊天。清空的文本段直接丢掉。
  const cleaned = merged
    .map((seg) => (seg.type === 'text' ? { ...seg, text: stripImageMarkers(seg.text) } : seg))
    .filter((seg) => seg.type !== 'text' || seg.text.length > 0);
  if (cleaned.length === 0) cleaned.push({ type: 'text', text: '……' });

  return { segments: cleaned, unknownTags, rejectedWeb, toolMarkers };
}

/** 本地图片转 OneBot 的 base64:// 形式——比文件路径可移植，不会被路径权限卡住。 */
export function toBase64Url(absPath) {
  const b64 = readFileSync(absPath).toString('base64');
  return `base64://${b64}`;
}

/**
 * 读不到就返回 null，不抛。
 *
 * 为什么必须有这个：表情包目录是**会变的**（用户随时替换、删除），
 * 而模型手里的标签列表可能已经过期。一张图读不出来，
 * **绝不该把整条回复带崩**——那句话本身还是要发出去的。
 */
export function toBase64UrlOrNull(absPath) {
  try {
    return toBase64Url(absPath);
  } catch {
    return null;
  }
}

/**
 * **这一轮该不该配表情包**（2026-10-21 加，2026-10-22 改成「冷却」✓）。
 *
 * ⚠️ 原来写的是 `turnNo % everyN === 0` ✗ —— 那是「**每第 N 轮必定发一张**」✗，
 *    用户要的是「**发过一张之后冷却 N 轮**」✓。差别：
 *    · 第 5 轮她没发 ⇒ 第 10 轮**不该补发** ✗；
 *    · 第 6 轮（上次发送已经够久）⇒ 应该允许 ✓。
 *
 * 判据：`turnNo - lastSentTurn >= everyN` ✓ —— 只有**真的带图发出去了**才更新 `lastSentTurn` ✓。
 * `lastSentTurn = 0`（从没发过）时，第 1 轮就可以发 ✓。
 *
 * @param {number} turnNo       这是第几轮（同一会话自增）
 * @param {number} lastSentTurn 上一次**真的发了图**是第几轮（没发过 = 0）
 * @param {number} everyN       冷却几轮，默认 5
 */
export function stickerCooled(turnNo, lastSentTurn = 0, everyN = 5) {
  const n = Math.max(1, Number(everyN) || 5);
  const now = Math.max(1, Number(turnNo) || 1);
  const last = Math.max(0, Number(lastSentTurn) || 0);
  if (last === 0) return true; // 从没发过 ⇒ 不受冷却限制 ✓（这一条我第一版写错了 ✗）
  return now - last >= n;
}
