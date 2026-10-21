/**
 * 用视觉模型给 stickers/ 里的图片自动打标签。
 *
 * 结果写进 `stickers/tags.json`（格式 `{ "文件名.png": "标签" }`）。
 * **不改你的文件名**——这是刻意的：文件名是你的，标签是推导出来的，覆盖掉你的命名不可逆。
 * 删掉 tags.json 就完全回到"用文件名当标签"的行为。
 *
 * 可以重复跑：默认只处理还没有标签的，`--force` 全部重新识别。
 *
 * 用法：
 *   node tools/tag-stickers.mjs             只处理没标签的
 *   node tools/tag-stickers.mjs --force     全部重来
 *   node tools/tag-stickers.mjs --dry       只看结果，不写文件
 *   node tools/tag-stickers.mjs --delay=0   不加间隔（默认每张之间等 400ms）
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { loadConfig, ROOT } from '../src/config.mjs';
import { askWithImage } from '../src/llm.mjs';
import { readTagMap } from '../src/stickers.mjs';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
const MAX_BYTES = 6 * 1024 * 1024;

const PROMPT = `这是一张聊天表情包（sticker）。请判断它在聊天里表达的情绪或用途，用一个中文词概括，2-4 个字。
参考：大笑、委屈、害羞、无语、嚣张、加油、摸摸头、在的、晚安、生气、得意、疑惑、哭泣、比心。
如果图里主要是文字，优先用那个文字；如果是画面，就用它传达的情绪。
只回复那一个词，不要标点、不要引号、不要解释。实在判断不出来就只回复一个问号。`;

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const dry = argv.includes('--dry');
const delayMs = Number((argv.find((a) => a.startsWith('--delay=')) ?? '--delay=400').split('=')[1]);

/** 把模型输出洗成一个干净的短标签；不合格就返回 null（宁可不标，也别标错）。 */
export function cleanTag(raw) {
  let t = String(raw ?? '').trim().split(/\s+/)[0] ?? '';
  // 模型很爱加书名号/引号/句号，一并剥掉
  t = t.replace(/[。，、！？"'`*【】\[\]()（）「」『』《》〈〉:：;；.!?,~～]/g, '').trim();
  if (!t || t === '?') return null;
  if (t.length > 6) return null;
  if (!/^[\u4e00-\u9fa5A-Za-z0-9]+$/.test(t)) return null;
  return t;
}

async function main() {
  const { config } = loadConfig();
  const dir = resolve(ROOT, config.stickers?.dir ?? 'stickers');
  const tagsFile = join(dir, 'tags.json');

  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    console.error(`找不到表情包目录：${dir}`);
    process.exit(1);
  }

  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && IMAGE_EXT.has(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();

  if (files.length === 0) {
    console.log(`目录里没有图片：${dir}`);
    return;
  }

  const existing = readTagMap(dir);
  const todo = force ? files : files.filter((f) => !existing[f]);

  console.log(`表情包目录：${dir}`);
  console.log(`共 ${files.length} 张；已有标签 ${Object.keys(existing).length} 个；本次要处理 ${todo.length} 张。`);

  // 先保留已有标签（--force 时也先留着，处理失败就不至于把好的标签弄丢）
  const result = {};
  for (const f of files) if (existing[f]) result[f] = existing[f];

  // 清掉已被删除的文件留下的陈旧标签。
  // **必须放在「没有要处理的就早退」之前**——否则删了图再跑，清理永远执行不到。
  const stale = Object.keys(existing).filter((k) => !files.includes(k));
  if (stale.length) {
    console.log(`清掉 ${stale.length} 个已删除文件留下的陈旧标签：${stale.slice(0, 5).join('、')}${stale.length > 5 ? '…' : ''}`);
    if (!dry) writeFileSync(tagsFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
  }

  if (todo.length === 0) {
    console.log('没有需要识别的图片。想全部重来就加 --force。');
    return;
  }
  console.log('');

  let ok = 0;
  let unsure = 0;
  let failed = 0;

  for (const [i, name] of todo.entries()) {
    const full = join(dir, name);
    const size = statSync(full).size;
    const prefix = `  [${String(i + 1).padStart(String(todo.length).length)}/${todo.length}]`;

    if (size > MAX_BYTES) {
      console.log(`${prefix} ${name} —— 跳过，${(size / 1048576).toFixed(1)}MB 太大`);
      continue;
    }

    try {
      const r = await askWithImage(config, {
        prompt: PROMPT,
        imageBase64: readFileSync(full).toString('base64'),
        mime: MIME[extname(name).toLowerCase()] ?? 'image/png',
        maxTokens: 20,
      });
      const tag = cleanTag(r.text);
      if (!tag) {
        console.log(`${prefix} ${name} —— 拿不准（模型说：${JSON.stringify(r.text.trim().slice(0, 24))}），保持原样`);
        unsure += 1;
      } else {
        result[name] = tag;
        ok += 1;
        console.log(`${prefix} ${name} -> 「${tag}」`);
        if (!dry) writeFileSync(tagsFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
      }
    } catch (err) {
      failed += 1;
      console.log(`${prefix} ${name} —— 失败：${err.message}`);
    }

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  // 兜底再同步一次（正常情况下前面已经写过）
  for (const k of Object.keys(result)) if (!files.includes(k)) delete result[k];
  if (!dry) writeFileSync(tagsFile, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log('');
  console.log(`完成：识别成功 ${ok}，拿不准 ${unsure}，失败 ${failed}。`);
  console.log(
    dry
      ? '（--dry：没有写文件）'
      : `已写入 ${tagsFile}；现在共 ${Object.keys(result).length} 个标签。机器人下次启动会读到它们。`,
  );
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith('tag-stickers.mjs') && process.argv[1].endsWith('tag-stickers.mjs');
if (isDirectRun) {
  main().catch((err) => {
    console.error(`打标签失败：${err.stack ?? err.message}`);
    process.exit(1);
  });
}
