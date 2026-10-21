/**
 * 静态检查：找图那两段里用到的标识符，是否都有定义（import / const / let / function / 参数）。
 *
 * ## 为什么需要它
 *
 * 2026-10-10 我在 `bot.mjs` 里写了裸 `refs`（正确名字是 `earlyCtx.refs`），`node --check`
 * **查不出来**（语法没错），只有真跑到那一行才抛 `ReferenceError` —— 而表现是
 * 「她用错误原文回你」，看着像她在编。同一天三次栽在这上面（见 `memory/lessons.md`）。
 * 这个检查器是**文本级**的（粗），但专治这一类「不会报错的错」。
 *
 * 跑法（工作区根目录）：
 *   node qq-bot/tools/check-undefined.mjs
 *
 * ⚠️ 它只覆盖**两段最容易出这种事的地方**（找图路由段 + 发图段）。别当成全仓检查器。
 * ⚠️ **输出里的可疑名字要先人工过一遍**：注释和 URL 会被误当标识符（下面 `ALLOW` 已列出已知的）。
 */
import { readFileSync } from 'node:fs';

/** 从工作区根或 qq-bot 目录里跑都能找到文件（别依赖 cwd 的猜测）。 */
const FILE = new URL('../bot.mjs', import.meta.url);
const src = readFileSync(FILE, 'utf8');
const lines = src.split('\n');

/**
 * 已知的**误报**（注释 / URL / 字符串里的词，不是标识符）：
 * 每次出现新的误报就往这里加一条，别让它长期带着噪音 —— 带噪音的检查器会被当成背景忽略。
 * · `map`：来自字符串 `'logs/character-map.json'`（`-map.` 被当成"标识符 + 点"）。
 */
/**
 * 已知的**误报**（注释 / URL / 字符串里的词，不是标识符）：
 * 每次出现新的误报就往这里加一条，别让它长期带着噪音 —— 带噪音的检查器会被当成背景忽略。
 * · `map`：来自字符串 `'logs/character-map.json'`（`-map.` 被当成"标识符 + 点"）。
 * · `b23`/`chat`/`qq`/`trace`/`vision`（2026-10-11 扩了"模块级区段"之后冒出来的）：
 *   分别来自 URL `b23.tv`、`'chat/completions'`、`CQ:…,qq=` 与 `seg.data.qq`、
 *   `trace.moe`、以及 `vision.mjs` 这种文件名 —— **都是字符串里的词**，不是变量。
 */
const ALLOW = new Set([
  'b', 'character', 'misses', 'www', 'imageSearch', 'x', 'it', 'lessons', 'map',
  'b23', 'chat', 'qq', 'trace', 'vision',
  // ideo.mjs（import 路径）与 'ffprobe'（ffmpeg 的兄弟程序名，出现在字符串里）—— 同一类误报
  'video', 'ffprobe', 'ffmpeg',
]);

const REGIONS = [
  /**
   * ⚠️ **2026-10-11 加：整个"模块级"区段**（`startBot` 之前的所有函数）。
   *
   * 起因是一个真 bug：`fetchImageAsBase64()` 的签名漏了 `log`，函数体里却用 `log?.warn?.(...)`，
   * 而它是**模块级**函数（不在 `startBot` 的词法作用域里）→ 一走到失败分支就抛
   * `log is not defined`，**整张图读不出来**（日志里 10-10 有 3 次，被当成"识图不准"）。
   * 同一类还查出 `sendPixivPack` / `writeCharacterMap` / `appendIntentMiss` 三处。
   *
   * 为什么以前查不出来：检查器只扫了下面两三个**区间**，598 行之前的模块级函数**从来没被扫过**。
   * 现在把这一整段纳入 —— 这类"名字写错/漏参数"的错误以后跑一次检查就现形。
   */
  { label: '模块级区段（startBot 之前）', from: 'const LOG_DIR = resolve(ROOT', to: 'export function startBot(' },
  { label: '找图路由段', from: 'const earlyCtx = ctxBase;', to: 'const r = await findAndSendImages' },
  { label: '发图段（findAndSendImages）', from: 'async function findAndSendImages(', to: 'async function say(' },
  // ⚠️ 2026-10-11 加：**漫画打包那段**也在模块顶层，同样容易写错名字（`makeZip` / `fetchPixivPages`…）
  { label: '打包段（wantsZipPack/sendPixivPack/sendPixivWork）', from: 'export function wantsZipPack(', to: 'function readCharacterMap()' },
];

// 收集"文件里出现过定义"的名字（粗）
const defined = new Set();
for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
/**
 * ⚠️ **解构定义也要算**（2026-10-11 补）：`const [descR, traceR] = await Promise.allSettled([...])`
 * 里的名字以前**没被识别**，于是被报成"可疑未定义" —— 那是**检查器自己的假阳性**。
 * 带噪音的检查器会被当成背景忽略（本项目旧教训），所以先把它修准。
 * 写法上**宁可多收**（把 `{ config: fresh }` 里的 `config` 也收进来）：
 * 多收只会让它更安静，比"每次跑都有一堆噪音"强。
 */
for (const m of src.matchAll(/(?:const|let|var)\s*[[{]([^\]}]*)[\]}]\s*=/g)) {
  for (const name of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) defined.add(name[0]);
}
for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) {
  for (const part of m[1].split(',')) {
    const name = part.trim().split(/\s+as\s+/).pop().trim();
    if (name) defined.add(name);
  }
}
for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) defined.add(m[1]);
// 参数与解构（粗：把形参名也算上）
for (const m of src.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) {
  for (const part of m[1].split(',')) {
    const name = part.replace(/[={}[\].:].*$/, '').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
  }
}

const GLOBALS = new Set([
  'console', 'process', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Set', 'Map',
  'Promise', 'Buffer', 'URL', 'RegExp', 'Error', 'parseInt', 'parseFloat', 'isNaN', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'structuredClone', 'fetch', 'AbortSignal', 'AbortController', 'TextEncoder', 'TextDecoder',
  'true', 'false', 'null', 'undefined', 'this', 'await', 'async', 'return', 'if', 'else', 'for', 'while', 'try',
  'catch', 'finally', 'throw', 'new', 'typeof', 'delete', 'in', 'of', 'instanceof', 'void', 'yield', 'function',
  'const', 'let', 'var', 'class', 'import', 'export', 'from', 'as', 'default', 'break', 'continue', 'case',
  'switch', 'do', 'with', 'debugger', 'super', 'static', 'get', 'set', 'key', 'repeat',
]);

let bad = 0;
for (const { label, from, to } of REGIONS) {
  const start = lines.findIndex((l) => l.includes(from));
  const end = lines.findIndex((l, i) => i > start && l.includes(to));
  if (start < 0 || end < 0) {
    console.log(`⚠️ ${label}：找不到区间（${from} → ${to}）—— 检查器要跟着代码改`);
    bad += 1;
    continue;
  }
  const region = lines.slice(start, end).join('\n');
  /**
   * ⚠️ **扫描前先去掉注释**（2026-10-14 加）。
   *
   * 起因：我在 `bot.mjs` 的注释里写了「原来只认 HTTP(S) 地址」这样一句 ✓，
   * 检查器把 `HTTP` 当成标识符报「可疑」✗（`http`/`HTTP` 大小写都躲不过 ✗）。
   * 以前的处理方式是往 `ALLOW` 里堆已知误报 ✗（治标 ✓）；去注释是**从根上少一类误报** ✓ ——
   * 注释里的词本来就不是标识符 ✓。
   * 副作用：字符串里出现的 `//`（比如 URL）也会被一起吃掉 —— 对"找标识符"这件事**无害** ✓。
   */
  const scan = region.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const used = new Set();
  for (const m of scan.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*[.(\[]/g)) used.add(m[1]);
  for (const m of scan.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  const missing = [...used].filter((n) => !defined.has(n) && !GLOBALS.has(n) && !ALLOW.has(n)).sort();
  console.log(`${label}：行 ${start + 1}–${end + 1}；用到 ${used.size} 个名字`);
  if (!missing.length) console.log('  ✓ 没有未定义的名字');
  else {
    console.log(`  ⚠️ 可疑（可能未定义）：${missing.join(', ')}`);
    bad += missing.length;
  }
}
process.exitCode = bad ? 1 : 0;
