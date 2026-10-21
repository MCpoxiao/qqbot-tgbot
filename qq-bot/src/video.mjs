/**
 * **看懂"他发来的视频"**（2026-10-11 用户批准装 ffmpeg 之后加的）。
 *
 * ## 为什么需要它
 * 用户问「我给他发的视频他能正确理解吗」——查下来**根本没有这条路**：消息里只剩字面量 `[视频]`，
 * 她要么顺着编、要么答非所问。本机原来**没装 ffmpeg**、也**没有 ASR**，所以画面和声音都拿不到。
 *
 * ## 帧数：用户的要求是"一分钟至少 20 帧"
 * 我最初想的是"整条视频抽 3~4 帧"（够看个大概），用户明确要 **≥20 帧/分钟**（≈每 3 秒一帧）。
 * 按他的来。但**每一帧发给视觉模型都是钱**（图片 token 是大头），逐张描述 60 帧会很贵。
 *
 * ## 省 token 的关键：**拼图（contact sheet）**
 * 用 ffmpeg 的 `tile` 滤镜把 N 帧拼成一张图（`scale` 先压到 480 宽再拼），
 * 于是 **20 帧 = 1 张图**发给模型 —— 密度满足要求、调用次数从 20 降到 1。
 * 需要逐帧细看时把 `mode` 设成 `'each'`（走逐张，贵但细）。
 *
 * ## 边界
 * - **只听得到画面、听不到声音**：本机没有 ASR，DeepSeek 也没有音频接口 ——
 *   所以提示词里明确写"**没有声音信息**"，别让它假装听到了。
 * - 这个模块**不碰网络也不碰 onebot**：下载与提问都从外面注入，方便单测。
 */

/** 抽帧/拼图的参数（都带上限，避免一条长视频把额度吃光）。 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const VIDEO_DEFAULTS = {
  /** **每分钟抽几帧**（用户要求 ≥20/分钟；≈每 3 秒一帧）。 */
  framesPerMinute: 20,
  /** 一条视频最多抽多少帧（150 = 7.5 分钟 @20帧/分钟；用户实际视频 5~6 分钟，见 config 里的说明）。 */
  maxFrames: 150,
  /** 一条视频最多看多少秒（超过就只看前这么多，并告知用户）。 */
  maxSeconds: 600,
  /** 拼图里每格缩到多宽（越小越省 token，480 仍能看清字幕/场景）。 */
  frameWidth: 480,
  /** 拼图每行几格（5×4=20 格一张）。 */
  sheetCols: 5,
  /** 拼图单张最多几格（超过就再拼一张）。 */
  sheetRows: 4,
  /** 逐帧模式下一帧最多给视觉模型多少 token。 */
  perFrameTokens: 60,
  /** 拼接模式下一次给多少（要能讲一段时间线）。 */
  perSheetTokens: 400,
};

/**
 * 规划抽帧：**先按"每分钟 20 帧"算间隔，再套上限**。
 *
 * @param {{durationSec?:number, framesPerMinute?:number, maxFrames?:number, maxSeconds?:number}} opts
 * @returns {{fps:number, frames:number, seconds:number, truncated:boolean, intervalSec:number}}
 *   `fps` 是给 ffmpeg 的取样频率；`truncated` 表示"视频比 maxSeconds 长，只看了前面一段"。
 */
export function planFrames({ durationSec = 0, framesPerMinute = VIDEO_DEFAULTS.framesPerMinute, maxFrames = VIDEO_DEFAULTS.maxFrames, maxSeconds = VIDEO_DEFAULTS.maxSeconds } = {}) {
  const perMin = Math.max(1, Math.min(120, Number(framesPerMinute) || VIDEO_DEFAULTS.framesPerMinute));
  const cap = Math.max(1, Math.min(300, Number(maxFrames) || VIDEO_DEFAULTS.maxFrames));
  const dur = Math.max(0, Number(durationSec) || 0);
  const seconds = dur > 0 ? Math.min(dur, Math.max(1, Number(maxSeconds) || VIDEO_DEFAULTS.maxSeconds)) : Math.max(1, Number(maxSeconds) || VIDEO_DEFAULTS.maxSeconds);
  // 先按"每分钟 perMin 帧"想要多少帧
  let frames = Math.max(1, Math.round((seconds / 60) * perMin));
  let truncated = false;
  if (frames > cap) {
    // 帧数超上限 → 要么少抽（拉长间隔），要么只取前面一段；这里选**拉长间隔**（覆盖全片更重要）
    frames = cap;
    truncated = dur > seconds;
  } else {
    truncated = dur > seconds;
  }
  // 至少 2 帧（1 帧看不出"变化"），但短视频（<2 秒）只给 1 帧
  if (seconds >= 2 && frames < 2) frames = 2;
  const fps = frames / seconds;
  return { fps, frames, seconds, truncated, intervalSec: frames > 0 ? seconds / frames : seconds };
}

/**
 * 生成 ffmpeg 参数：抽帧 → 缩放 → 拼图。
 *
 * ⚠️ 用 `tile` 而不是输出 N 个 png：**一次调用出一张拼图**，
 * 少写盘、少读盘，也给视觉模型一次看 20 个画面（比逐帧描述更省 token）。
 *
 * @returns {{args:string[], out:string, kind:'sheet'|'frames'}}
 */
export function buildFrameCommand({ input, outDir, plan, mode = 'sheet', opts = {} } = {}) {
  const O = { ...VIDEO_DEFAULTS, ...opts };
  const w = Math.max(120, Math.min(1280, Number(O.frameWidth) || VIDEO_DEFAULTS.frameWidth));
  const cols = Math.max(1, Math.min(10, Number(O.sheetCols) || VIDEO_DEFAULTS.sheetCols));
  const rows = Math.max(1, Math.min(10, Number(O.sheetRows) || VIDEO_DEFAULTS.sheetRows));
  const perSheet = cols * rows;
  const want = Math.max(1, Math.min(300, Number(plan?.frames) || 1));
  const fps = Number(plan?.fps) || 0.3333;
  // `-vf fps=…,scale=…,tile=colsxrows` 一次出一张；帧数多于一张容量时 ffmpeg 会继续输出第 2、3 张
  const vf = `fps=${fps.toFixed(4)},scale=${w}:-2,tile=${cols}x${rows}`;
  if (mode === 'each') {
    return {
      kind: 'frames',
      out: `${outDir}/f%03d.jpg`,
      args: ['-hide_banner', '-loglevel', 'error', '-i', input, '-vf', `fps=${fps.toFixed(4)},scale=${w}:-2`, '-frames:v', String(want), '-q:v', '4', `${outDir}/f%03d.jpg`],
    };
  }
  return {
    kind: 'sheet',
    out: `${outDir}/sheet%02d.jpg`,
    args: ['-hide_banner', '-loglevel', 'error', '-i', input, '-vf', vf, '-frames:v', String(Math.ceil(want / perSheet)), '-q:v', '4', `${outDir}/sheet%02d.jpg`],
  };
}

/**
 * 给视觉模型的提问（拼图版）。
 *
 * ⚠️ 三件事必须写清楚，否则它会**编**：
 *   ① 这是**按时间顺序**排的格子（从左到右、从上到下），不是一张合影；
 *   ② 每格大概代表第几秒（给它每格的间隔，让它能说"大约第 X 秒"）；
 *   ③ **没有声音** —— 别写"视频里说…"这种它听不到的东西。
 */
export function videoPrompt(question = '', { mode = 'sheet', frames = 20, intervalSec = 3, cols = 5 } = {}) {
  const q = String(question ?? '').trim().slice(0, 120);
  if (mode === 'each') {
    return (
      (q ? `他发这段视频时说的是：「${q}」——优先照这个点看。\n` : '') +
      '这是一段视频里按时间顺序抽的一帧。用中文说这一帧里**能核对的东西**：画面里的文字（尽量原样抄）、' +
      '人在做什么、场景。**没有人声信息**（我只拿到了画面），别写"他说了什么"。40 字以内。'
    );
  }
  return (
    (q ? `他发这段视频时说的是：「${q}」——优先照这个点看。\n` : '') +
    `这是一段视频抽成的**画面拼图**：一共 ${frames} 格，**按时间顺序**排列（从左到右、从上到下），` +
    `每格大约相隔 ${intervalSec.toFixed(1)} 秒（所以第 1 格≈开头，最后 1 格≈第 ${Math.round(frames * intervalSec)} 秒）。\n` +
    '请用中文说清楚：①**画面里出现的文字**（有就原样抄，这是最可靠的线索）；②这段视频**整体在讲什么/发生了什么**' +
    '（按时间顺序，别当成一张合影）；③场景或用途。\n' +
    '**注意：我只拿到了画面，没有任何声音信息** —— 不要写"视频里说/提到"这类内容。' +
    '拿不准的写"不确定"。200 字以内，直接说内容。'
  );
}

/**
 * 把若干张拼图/帧的描述**按时间顺序**并成一段"时间线"文本（给模型当资料用）。
 *
 * @param {Array<{kind:'sheet'|'frame', index:number, from:number, to:number, text:string}>} parts
 */
export function buildTimeline(parts, { maxChars = 1600 } = {}) {
  const list = (parts ?? []).filter((p) => p && String(p.text ?? '').trim());
  if (!list.length) return '';
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const lines = list.map((p, i) => {
    const span = p.kind === 'sheet' ? `${fmt(p.from)}–${fmt(p.to)}` : `${fmt(p.from)}`;
    return `${i + 1}. [${span}] ${String(p.text).replace(/\s+/g, ' ').trim()}`;
  });
  const out = lines.join('\n');
  return out.length > maxChars ? `${out.slice(0, maxChars)}…（后面还有画面，太长省略）` : out;
}

// ─────────────────────────── 下面这些会碰磁盘/子进程（纯函数在上面） ───────────────────────────

/**
 * **找 ffmpeg/ffprobe**：`PATH` 扫一遍 + 几个已知安装位置（winget 的包目录）。
 *
 * ⚠️ 为什么不能只靠 `ffmpeg` 这个名字：**机器人进程是在装 ffmpeg 之前启动的**，
 * 它的 `PATH` 里根本没有 —— winget 说"重启 shell 才生效"。所以这里自己找，
 * 找到就用**绝对路径**（配置里也可以直接写死）。
 * 纯 fs 检查，不起子进程（沙箱里起子进程抓输出会被拒，见 README）。
 */
export function resolveFfmpeg({ pathEnv = process.env.PATH ?? '', extra = [], homedir = process.env.LOCALAPPDATA ?? '' } = {}) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const dirs = [
    ...String(pathEnv).split(process.platform === 'win32' ? ';' : ':'),
    ...extra,
    homedir ? `${homedir}\\Microsoft\\WinGet\\Packages` : '',
  ].filter(Boolean);
  const isFile = (p) => {
    try {
      return existsSync(p) && statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const hit = (dir, name) => {
    const direct = join(dir, `${name}${exe}`);
    if (isFile(direct)) return direct;
    // winget 的包目录是 `…\Packages\Gyan.FFmpeg_…\ffmpeg-<版本>-full_build\bin\`
    if (!dir.endsWith('Packages')) return '';
    try {
      for (const pkg of readdirSync(dir)) {
        if (!/ffmpeg/i.test(pkg)) continue;
        const root = join(dir, pkg);
        for (const sub of readdirSync(root)) {
          const cand = join(root, sub, 'bin', `${name}${exe}`);
          if (isFile(cand)) return cand;
        }
      }
    } catch {
      /* 目录不存在等 */
    }
    return '';
  };
  let ffmpeg = '';
  let ffprobe = '';
  for (const d of dirs) {
    if (!ffmpeg) ffmpeg = hit(d, 'ffmpeg');
    if (!ffprobe) ffprobe = hit(d, 'ffprobe');
    if (ffmpeg && ffprobe) break;
  }
  return { ffmpeg, ffprobe, ok: Boolean(ffmpeg) };
}

/**
 * 探测时长（秒）。
 *
 * ⚠️ **不让 Node 抓子进程的管道输出**：受限沙箱下 `spawn` 的管道 stdio 会直接 `EPERM`
 * （2026-10-11 实测），而"机器人跑在沙箱外"不代表**测试**也跑在沙箱外。
 * 第一版想用 `cmd /c "… > out"` 绕开，结果 **cmd 把首尾引号吃掉**、探测恒为 0（写了个静默的坑）。
 * 现在改成：**给子进程一个"指向文件"的 stdout 句柄**（文件不是管道，两边都能跑，也没有引号问题）。
 * 探测失败返回 0（调用方按"未知时长"处理，别当成错误）。
 */
export async function probeDurationSec(ffprobe, file, { timeoutMs = 15000, tmpFile = '', run = defaultRun } = {}) {
  if (!ffprobe) return 0;
  const out = tmpFile || `${file}.dur.txt`;
  let fd = null;
  try {
    fd = openSync(out, 'w');
    await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      timeoutMs,
      stdio: ['ignore', fd, 'ignore'],
    });
    const txt = readFileSync(out, 'utf8').trim();
    const n = Number(String(txt).split('\n').pop());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  } finally {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      /* 忽略 */
    }
    try {
      rmSync(out, { force: true });
    } catch {
      /* 清不掉也无所谓 */
    }
  }
}

/** 抽帧/拼图（真的调 ffmpeg），返回产出的文件列表（按名排序）。 */
export async function extractFrames({ ffmpeg, input, outDir, plan, mode = 'sheet', opts = {}, run = defaultRun, timeoutMs = 120000 } = {}) {
  if (!ffmpeg) throw new Error('没找到 ffmpeg');
  await fsp.mkdir(outDir, { recursive: true });
  const cmd = buildFrameCommand({ input, outDir, plan, mode, opts });
  await run(ffmpeg, cmd.args, { timeoutMs, stdio: 'ignore' });
  return readdirSync(outDir)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort()
    .map((f) => join(outDir, f));
}

/**
 * 一帧/一张拼图对应**哪一段时间**（给 `buildTimeline` 用）。
 * 拼图模式下：第 i 张覆盖 `[i*perSheet*interval, (i+1)*perSheet*interval]`。
 */
export function sheetSpan(index, { frames = 20, intervalSec = 3, perSheet = 20 } = {}) {
  const from = index * perSheet * intervalSec;
  const to = Math.min(frames * intervalSec, (index + 1) * perSheet * intervalSec);
  return { from, to };
}

/** 默认的子进程执行器（可注入，测试时不必真跑 ffmpeg）。 */
async function defaultRun(bin, args, { timeoutMs = 120000, stdio = 'ignore' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio, windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      reject(new Error(`执行超时（${timeoutMs}ms）：${bin}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code });
      else reject(new Error(`${bin} 退出码 ${code}`));
    });
  });
}
