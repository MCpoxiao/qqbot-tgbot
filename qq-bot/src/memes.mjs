/**
 * 梗库：一个用户可编辑的纯文本文件，**清洗后**接进 system。
 *
 * 为什么要"给清单"而不是"教它玩梗"：实测模型**认识**大多数网络梗
 * （12 个当前热梗全部答对、解释也对），但它不会主动去用；
 * 而光写"该用就用"没用——加一句"别硬凑"之后，它一个梗都不用了。
 * 给它一份具体清单，它才有伸手可够的池子。
 *
 * 这份清单最不可替代的价值是**群内梗**：那是模型无论如何都推不出来的。
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.mjs';

/** 接进 prompt 的字数上限。超了就截断——梗库不该把上下文吃光。 */
export const MAX_MEME_CHARS = 2000;

/**
 * 清洗梗库文本。
 *
 * **必须清洗**：文件里带着给人看的说明和例子，整份塞进 system 的话，
 * 模型会把说明里的示例当成真梗来用（差点就这么干）。
 * 现在只保留"梗条目"：去掉注释（`#` 开头）、空行、以及 ``` 代码块。
 */
export function cleanMemes(raw) {
  const lines = [];
  let inFence = false;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (/^```/.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!t) continue;
    if (t.startsWith('#')) continue;
    lines.push(t);
  }
  return lines.join('\n');
}

/**
 * 读梗库。文件不存在时返回空字符串（不报错——没有梗库也能正常聊天）。
 */
export function loadMemes(relPath = 'memes.md', { maxChars = MAX_MEME_CHARS } = {}) {
  const file = resolve(ROOT, relPath);
  let raw = '';
  let mtime = 0;
  try {
    raw = readFileSync(file, 'utf8');
    mtime = statSync(file).mtimeMs;
  } catch {
    return { file, text: '', total: 0, truncated: false, mtime: 0 };
  }
  const cleaned = cleanMemes(raw);
  const truncated = cleaned.length > maxChars;
  return {
    file,
    text: truncated ? cleaned.slice(0, maxChars) : cleaned,
    total: cleaned.length,
    truncated,
    mtime,
  };
}

/** 文件指纹，用来判断"用户改过没有"。 */
export function memesStamp(relPath = 'memes.md') {
  try {
    return statSync(resolve(ROOT, relPath)).mtimeMs;
  } catch {
    return 0;
  }
}
