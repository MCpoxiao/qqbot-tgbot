/**
 * **给表情包库生成"视觉描述索引"**（2026-10-22 用户要求）。
 *
 * 为什么需要：机器人选表情包时只看到**标签名**（"不可以""傲娇"…）✗，
 * 看不到图 ✓ ⇒ 选得准不准全靠标签语义碰运气 ✗。给每个标签补一句"这张图长什么样"✓，
 * 她就能按画面挑（"一张捂住脸偷笑的猫"✓），而不是只按词频猜。
 *
 * 做法：**每个标签取代表图**（`loadStickers().pick(tag)` ✓）→ 视觉模型 → 一句话描述 ✓，
 * 存进 `<表情包目录>/.descriptions.json` ✓（可续跑 ✓、只补缺的 ✓）。
 *
 * 成本：一个标签一次识图 ≈ 1.1k token ✓；104 个标签 ≈ **0.2~0.5 元** ✓。
 *
 * 用法：
 *   node qq-bot/tools/describe-stickers.mjs            # 全部补齐（已描述的跳过）
 *   node qq-bot/tools/describe-stickers.mjs --limit 6  # 只跑 6 个（先验一下质量）
 *   node qq-bot/tools/describe-stickers.mjs --dry      # 只列出缺哪些，不调模型
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadStickers } from '../src/stickers.mjs';
import { askWithImage } from '../src/llm.mjs';
import { loadConfig } from '../src/config.mjs';

const argv = process.argv.slice(2);
const limit = Number((argv.find((a) => a.startsWith('--limit')) ?? '').split('=')[1] ?? 0) || 0;
const dry = argv.includes('--dry');
const DIR_REL = 'stickers';

const cfg = loadConfig({}).config;
const st = loadStickers(DIR_REL);
console.log(`  表情包库：${st.count} 张 / ${st.tags.length} 个标签（目录 ${st.dir}）`);
if (!st.tags.length) { console.log('  ✗ 没有标签，先确认 stickers 目录'); process.exit(0); }

const OUT = join(st.dir, '.descriptions.json');
let map = {};
if (existsSync(OUT)) {
  try { map = JSON.parse(readFileSync(OUT, 'utf8')); } catch { map = {}; }
}
const missing = st.tags.filter((t) => !map[t]);
console.log(`  已有描述 ${Object.keys(map).length} 个 ｜ 缺 ${missing.length} 个`);
if (dry) { console.log('  （--dry 只列出，不调模型）缺的例子：' + missing.slice(0, 12).join('、')); process.exit(0); }

const PROMPT =
  '这是一张聊天用的表情包图片（可能是动漫角色、梗图或动物）。' +
  '请用**一句中文**说清：画面里是什么、什么表情/动作、图上如果有文字就写出来。' +
  '只描述你**真的看到**的，别猜用途、别加"这张图表达了…"这类解释。30 字以内。';

const save = () => writeFileSync(OUT, JSON.stringify(map, null, 2) + '\n', 'utf8');
let done = 0, failed = 0;
const t0 = Date.now();
for (const tag of missing) {
  if (limit && done >= limit) break;
  const file = st.pick(tag);
  if (!file || !existsSync(file)) { failed += 1; console.log(`  ✗ ${tag}：拿不到图片文件`); continue; }
  const buf = readFileSync(file);
  const ext = (file.split('.').pop() ?? '').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  // ⚠️ 2026-10-22：第一次批量跑时 83/101 都是 `fetch failed` ✗ —— 代理在抖 ✓，
  //   不是这张图有问题 ✗。所以**每张最多试 3 次**、退避 2s/6s ✓；仍然失败才跳过 ✓（下次续跑会补 ✓）。
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
    try {
      const r = await askWithImage(cfg, {
        system: '你在给表情包打一句话标签。只描述画面，简短。',
        prompt: PROMPT,
        imageBase64: buf.toString('base64'),
        mime,
        maxTokens: 90,
      });
      const text = String(r?.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!text) throw new Error('空描述');
      map[tag] = text;
      done += 1;
      ok = true;
      save(); // 每张都落盘 ⇒ 中断也不丢 ✓
      console.log(`  ✓ ${tag} → ${text}`);
    } catch (e) {
      const msg = String(e?.message ?? e).slice(0, 50);
      if (attempt < 3) {
        const wait = attempt === 1 ? 2000 : 6000;
        console.log(`  … ${tag} 第 ${attempt} 次失败（${msg}），${wait / 1000}s 后重试`);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        failed += 1;
        console.log(`  ✗ ${tag}：放弃（${msg}）`);
      }
    }
  }
}
save();
console.log(`\n  完成 ${done} 个 ｜ 失败 ${failed} 个 ｜ 用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
console.log(`  描述文件：${OUT}（共 ${Object.keys(map).length} 条）`);
