/**
 * 修她马上会撞的两堵墙（2026-10-20 实测）：
 *   ① 蔚蓝档案是 **Unity** ⇒ `uiautomator dump` 拿到 **0 个元素** ✗（整块画布无无障碍节点）
 *      ⇒ 她只能「看图估坐标」✗，而我们实测估坐标会差 ~200px ✗
 *   ② 游戏截图 **2.7MB** ⇒ 识图请求 **30 秒超时** ✗（设置页才 124KB 就没事 ✓）
 *
 * 修法：截图走 ffmpeg 转 **JPEG + 画 200px 网格** ✓
 *   · JPEG 压体积 ✓（不超时）
 *   · 网格给她**读坐标的标尺** ✓
 *   · **不缩放** ⇒ 网格坐标 = 真实屏幕坐标 ✓（不用换算，避免又差一个系数 ✗）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const runFf = (args) =>
  new Promise((resolve) => {
    try {
      execFile('ffmpeg', args, { timeout: 20000, windowsHide: true }, (err, _o, se) => {
        resolve(err ? { ok: false, err: String(se || err.message).slice(0, 200) } : { ok: true });
      });
    } catch (e) {
      resolve({ ok: false, err: String(e.message).slice(0, 200) });
    }
  });

/** PNG Buffer → JPEG Buffer（带网格）。失败就返回 null（上层退回原 PNG ✓） */
export async function toVisionJpeg(pngBuf, { grid = 200, quality = 5 } = {}) {
  const tag = 'shot-' + process.pid + '-' + Date.now();
  const inP = join(tmpdir(), tag + '.png');
  const outP = join(tmpdir(), tag + '.jpg');
  try {
    writeFileSync(inP, pngBuf);
    const vf = grid > 0 ? `drawgrid=w=${grid}:h=${grid}:t=2:c=red@0.55` : 'scale=iw:ih';
    // -q:v 5 ≈ 质量 75 左右；2560x1440 的游戏画面大概 300~500KB ✓
    const r = await runFf(['-y', '-loglevel', 'error', '-i', inP, '-vf', vf, '-q:v', String(quality), outP]);
    if (!r.ok) return null;
    const jpg = readFileSync(outP);
    return jpg.length > 800 ? jpg : null;
  } catch {
    return null;
  } finally {
    try { writeFileSync(inP, ''); } catch { /* 忽略 */ }
  }
}

/** 一个能读的视频帧/截图尺寸估计（给提示词用） */
export function sizeHint(bytes) {
  return Math.round((bytes ?? 0) / 1024) + 'KB';
}
