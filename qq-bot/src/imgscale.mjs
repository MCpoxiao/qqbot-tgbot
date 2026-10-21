/**
 * **发给视觉模型之前把图压小**（2026-10-12 加）。
 *
 * ## 为什么需要
 * 用户报「识图有点不行」，日志给了两个实锤（2026-10-12）：
 * ```
 * 02:35:07 [识图] （这张图模型没说出内容）          ← 模型返回空
 * 04:29:15 [warn] 读图失败：请求超时（60000ms）     ← 直接超时
 * ```
 * 一次是空、一次是 60 秒超时 —— 共同点是**图太大**：QQ 原图常有几 MB，
 * base64 之后还要再涨 1/3，上传就把 60 秒的额度吃光了。
 *
 * ## 为什么缩到 1280 仍然够用
 * 2026-10-11 的对照实验（见 `archive/2026-10-11-视频抽帧理解/证据-像素对照实验.txt`）：
 * **单帧 1280px 时，模型准确读出了 20px 的小水印**（`ID:8848-XZ`，602 tokens）；
 * 而 480px 的同一帧只能说"读不清"。所以 1280 是"够读细节、又不至于太大"的位置。
 *
 * ## 实现上的两个约束
 * 1. **走临时文件，不走管道** —— 受限沙箱下 `spawn` 的管道 stdio 会 `EPERM`
 *    （2026-10-11 实测），文件方式两边都能跑。
 * 2. **ffmpeg 找不到 / 失败 → 原图照发**（宁可慢，也不能因为缩图失败而发不出图）。
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFfmpeg } from './video.mjs';

/**
 * 把一张图缩到 `maxWidth` 宽（保持比例），转 JPEG。
 *
 * @param {Buffer} buffer 原图字节
 * @param {{maxWidth?:number, quality?:number, tmpDir:string, ffmpeg?:string, run?:Function, timeoutMs?:number}} opts
 * @returns {Promise<{buffer:Buffer, mime:string, shrank:boolean, from:number, to:number, note:string}>}
 *   `shrank=false` 时 `buffer` 就是原图（没 ffmpeg / 已经够小 / 失败）
 */
export async function shrinkImage(buffer, { maxWidth = 1280, quality = 4, tmpDir, ffmpeg = '', run = defaultRun, timeoutMs = 30000 } = {}) {
  const original = { buffer, mime: 'image/jpeg', shrank: false, from: buffer?.length ?? 0, to: buffer?.length ?? 0, note: '' };
  if (!buffer?.length) return { ...original, note: '空图' };
  if (!tmpDir) return { ...original, note: '没给临时目录' };
  const bin = String(ffmpeg || '') || resolveFfmpeg().ffmpeg;
  if (!bin) return { ...original, note: '没找到 ffmpeg（原图照发）' };
  const w = Math.max(320, Math.min(2048, Number(maxWidth) || 1280));
  const inFile = join(tmpDir, 'vision-in.bin');
  const outFile = join(tmpDir, 'vision-out.jpg');
  try {
    await fsp.mkdir(tmpDir, { recursive: true });
    await fsp.writeFile(inFile, buffer);
    /**
     * `scale='min(W,iw)':-2` —— **只缩小、不放大**（小图保持原样，放大会浪费 token 又不增信息）；
     * `-2` 让高度取整到偶数（JPEG 要求）。
     */
    await run(bin, ['-hide_banner', '-loglevel', 'error', '-i', inFile, '-vf', `scale='min(${w},iw)':-2`, '-q:v', String(quality), '-y', outFile], { timeoutMs });
    if (!existsSync(outFile)) return { ...original, note: 'ffmpeg 没产出文件（原图照发）' };
    const out = await fsp.readFile(outFile);
    if (!out.length) return { ...original, note: '缩图是空的（原图照发）' };
    // 缩完反而更大就别用（极小图有可能）
    if (out.length >= buffer.length) return { ...original, note: `缩图没变小（${out.length}≥${buffer.length}），用原图` };
    return { buffer: out, mime: 'image/jpeg', shrank: true, from: buffer.length, to: out.length, note: '' };
  } catch (err) {
    return { ...original, note: `缩图失败：${err.message}` };
  } finally {
    try {
      await fsp.rm(inFile, { force: true });
      await fsp.rm(outFile, { force: true });
    } catch {
      /* 清不掉无所谓 */
    }
  }
}

/** 默认执行器（`stdio: 'ignore'`，不抓管道 —— 沙箱内外都能跑）。 */
async function defaultRun(bin, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      reject(new Error(`超时 ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`退出码 ${code}`));
    });
  });
}
