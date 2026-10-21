import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, describeBackend, ROOT } from './src/config.mjs';
import { OneBot } from './src/onebot.mjs';
import { Telegram } from './src/telegram.mjs';
import { askWithImage, createLLM, createToolChat, withRetry } from './src/llm.mjs';
import { imageDisciplineNote, parseScreenVerdict, screenAsk, visionPrompt } from './src/vision.mjs';
import { VIDEO_DEFAULTS, buildTimeline, extractFrames, planFrames, probeDurationSec, resolveFfmpeg, sheetSpan, videoPrompt } from './src/video.mjs';
import { singHint } from './src/lyrics.mjs';
import { shrinkImage } from './src/imgscale.mjs';
import {
  nowLabel,
  nowLabelShort,
  timeAnchor,
  searchImageUrls,
  fetchImageBytes,
  collectFreshImages,
  recentSentKeys,
  rememberSentImages,
} from './src/tools.mjs';
import { trimSubtitle, buildJudgeAsk, parseJudge, bigCover } from './src/watch.mjs';
import { parseBvid, videoInfoRaw, getSubtitle, hotBilibiliList } from './src/bilibili.mjs';
import {
  describeNoSend,
  fetchPixivImage,
  fetchPixivPages,
  fetchPixivWork,
  filterExcluded,
  parseTagQuery,
  pixivAllowedFor,
  pixivSearchTagged,
  pixivZipName,
  stripImageAskBoilerplate,
} from './src/pixiv.mjs';
import { makeZip } from './src/zip.mjs';
import { ChatArchive, timeRecallHint } from './src/chatlog.mjs';
import { searchTagFor } from './src/pixiv-tags.mjs';
import { buildResolveAsk, interpretPendingAnswer, needResolve, parseResolveJson, searchWordFor } from './src/character.mjs';
import { looksLikeImageAsk } from './src/intents.mjs';
import { recallPast, detectTopics, formatHint as formatAssocHint } from './src/assoc.mjs'; // 联想记忆（2026-10-20）
// ⚠️ 冲浪那套函数**必须显式导入**：漏了不会有编译错误，只会在 setInterval 里抛
//    `shouldSurf is not defined`（2026-10-08 实测：冲浪因此**从来没真正跑过**，
//    每 10 分钟往日志里扔一条 warn，而没人看）。
import { shouldSurf, surfGapMs, pickFresh, isUsableItem, orderItems, parseSearchLines, pickQuery, itemKey } from './src/surf.mjs';
import { claimMismatch, controlActionClaim, extractDraft, honestNote, parseProfileProposal, toolBlameMismatch } from './src/honesty.mjs';
import { TOOL_DEFS, createWebImageGate, execTool } from './src/tools.mjs';
import { Sessions } from './src/session.mjs';
import { createRouter, extractImages, extractText, stripImagePlaceholders } from './src/router.mjs';
import {
  TAGS_MANUAL_FILE,
  TAGS_VISION_FILE,
  isHumanTag,
  loadStickers,
  splitReply,
  stripImageMarkers,
  toBase64UrlOrNull,
} from './src/stickers.mjs';
import { parseSessionKey, shouldPing } from './src/proactive.mjs';
import { composeAddressing, createTonePicker, pickAddressScene, vibeNote } from './src/addressing.mjs';
import {
  bratTildeSegments,
  bubbleDelayMs,
  describeSegments,
  ensureTextWithMusic,
  looksBratty,
  splitIntoBubbles,
} from './src/style.mjs';
import { repeatedGimmicks, repeatNote } from './src/repeat.mjs';
import { loadMemes, memesStamp } from './src/memes.mjs';
import { findSong } from './src/music.mjs';
import { COMMAND_HELP, looksLikeCommand, parseCommand } from './src/commands.mjs';
import { controlAllowed, runControlTool, toolsForContext, CONTROL_TOOL_NAMES } from './src/control.mjs';
import { selfInitiatedHint, draftKind, qqactAllowed } from './src/qqact.mjs';
import { biliActAllowed } from './src/biliact.mjs';
import { matchIntent } from './src/intents.mjs';
import {
  REMINDER_TOOL_NAMES,
  Reminders,
  humanizeGap,
  remindersAllowed,
  looksLikeReminderAsk,
  promisesReminder,
} from './src/reminders.mjs';
import { Memory, MEMORY_TOOL_NAMES, buildConsolidationAsk, draftFrom, formatDraft, isDraftApproval, localDay } from './src/memory.mjs';
import { ApprovalWatcher, formatApproval } from './src/approvals.mjs';
import {
  collectProcesses,
  collectStatus,
  collectWindows,
  formatProcesses,
  formatStatus,
  formatWindows,
} from './src/system.mjs';
import { identifyImage } from './src/imagesearch.mjs';
import { localDateStamp, localStamp } from './src/timefmt.mjs';

const LOG_DIR = resolve(ROOT, 'logs');
const CONFIG_FILE = resolve(ROOT, 'config.json');
const STATUS_FILE = resolve(LOG_DIR, 'bot-status.json');
const RECENT_MAX = 20;
/**
 * **只在私聊里响应**的命令（只读的状态类）。
 *
 * 主机名、盘符余量、进程名、窗口标题都是本机信息，不该出现在群里；
 * 而且这些命令是给主人的，不是给群成员的表演。群里即便主人来问也只回一句。
 */
const PRIVATE_ONLY_COMMANDS = new Set(['status', 'processes', 'windows']);
const LOCK_FILE = resolve(LOG_DIR, 'bot.lock');
/** 控制面板写这个文件 = 「立刻试一次主动开口」，用来免等三小时预览效果。 */
const PING_NOW_FILE = resolve(LOG_DIR, 'ping-now');

/**
 * 单实例锁。
 *
 * 为什么需要：**DSH 的 `job_kill` 只终止 pwsh 外壳，不会杀掉后台任务里的 node 子进程**（Windows 上实测）。
 * 于是每次"重启机器人"都会留下一个僵尸实例，它还连着 OneBot——
 * 攒到 5 个的时候，用户发一句话会被回复 5 次。
 *
 * 用 PID 探活（signal 0）判断锁的持有者是否还活着；进程已经没了就接管锁。
 */
/** 单张图上限：QQ 图常见几百 KB，超过 8MB 基本是原图，读它性价比太低。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * **看懂"他发来的视频"**（2026-10-11，用户批准装 ffmpeg 之后）。
 *
 * 流程：下载视频（**有上限，超过就不下**）→ ffprobe 探时长 → 按"**每分钟 20 帧**"抽帧
 * （用户明确要求 ≥20 帧/分钟；我原来说的"3~4 帧"是整个视频 3~4 张，那太少了）→
 * 拼成**九宫格拼图**（一次给模型看 20 个画面，省的是**调用次数**）→ 逐张问视觉模型 → 拼成时间线。
 *
 * ⚠️ **只有画面、没有声音**：本机没有 ASR，DeepSeek 也没有音频接口 ——
 * 提示词里写死"没有任何声音信息"，免得它假装听到了。
 * ⚠️ **绝不阻塞太久**：整体有软截止时间（默认 90 秒），到点就用**已拿到的**那几张收尾；
 * 任何一步失败都返回空串（调用方退回"看不了"的如实说法）。
 */
export async function describeVideo(state, seg, { log = console, question = '', ask = askWithImage } = {}) {
  const V = state?.video ?? {};
  if (V.enabled === false) return '';
  /**
   * ⚠️ **本地文件也能看**（2026-10-14 加，为 Telegram）：
   * 原来只认 HTTP(S) 地址 ✗ —— 而 **TG 的视频是本地文件** ✓（传输层已经 `getFile` 下好了 ✓），
   * 于是视频那条「复用」根本走不通 ✗（直接 `return ''` ✓）。QQ 那边 NapCat 有时也直接给本地路径 ✓，
   * 所以这一改**两边都受益** ✓。
   */
  const fileRaw = String(seg?.file ?? '');
  const localPath = fileRaw.startsWith('file://')
    ? fileRaw.replace(/^file:\/\//, '')
    : /^https?:/i.test(fileRaw) || !fileRaw
      ? ''
      : fileRaw; // 裸本地路径（QQ 的 NapCat 会给这种 ✓）
  const url = /^https?:/i.test(String(seg?.url ?? '')) ? String(seg.url) : /^https?:/i.test(fileRaw) ? fileRaw : '';
  if (!url && !localPath) return ''; // 既没有 URL 也没有可读的本地文件
  const found = resolveFfmpeg({ extra: [V.ffmpeg ? dirname(String(V.ffmpeg)) : ''].filter(Boolean) });
  const binFf = String(V.ffmpeg ?? '') || found.ffmpeg;
  const binProbe =
    String(V.ffprobe ?? '') ||
    found.ffprobe ||
    (binFf ? join(dirname(binFf), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : '');
  if (!binFf) {
    log.warn?.('[视频] 没找到 ffmpeg（装好后重启机器人；或把路径写进 config 的 video.ffmpeg）—— 这轮只能说"看不了"');
    return '';
  }
  const maxBytes = Math.max(1024 * 1024, Number(V.maxBytes) || 40 * 1024 * 1024);
  const deadline = Date.now() + (Number(V.timeoutMs) || 90000);
  const dir = join(LOG_DIR, 'video-tmp', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const file = join(dir, 'in.mp4');
  try {
    await fsp.mkdir(dir, { recursive: true });
    /**
     * ① **拿到文件**：本地就复制 ✓（TG 已经下好、QQ 的 NapCat 有时也给本地路径 ✓），
     *    否则才走网络下载 ✓。上限检查对两条路都做 ✓。
     */
    if (localPath) {
      const st = await fsp.stat(localPath).catch(() => null);
      if (!st) {
        log.warn?.(`[视频] 本地文件读不到：${localPath}`);
        return '';
      }
      if (st.size > maxBytes) {
        log.warn?.(`[视频] 太大（${Math.round(st.size / 1048576)}MB > 上限 ${Math.round(maxBytes / 1048576)}MB）—— 跳过，只说"看不了"`);
        return '';
      }
      await fsp.copyFile(localPath, file);
      log.info?.(`[视频] 用本地文件（${Math.round(st.size / 1024)}KB）`);
    } else {
    // ①b 远端：先看 content-length，超上限就不下
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://qq.com/' } });
    if (!res.ok) throw new Error(`下载视频 HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len && len > maxBytes) {
      log.warn?.(`[视频] 太大（${Math.round(len / 1048576)}MB > 上限 ${Math.round(maxBytes / 1048576)}MB）—— 跳过，只说"看不了"`);
      return '';
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('视频是空的');
    if (buf.length > maxBytes) throw new Error(`视频太大（${Math.round(buf.length / 1048576)}MB）`);
    await fsp.writeFile(file, buf);
    }
    // ② 探时长 → 规划帧数 → 抽帧拼图
    const dur = await probeDurationSec(binProbe, file, { timeoutMs: 15000, tmpFile: join(dir, 'dur.txt') });
    const plan = planFrames({
      durationSec: dur,
      framesPerMinute: V.framesPerMinute,
      maxFrames: V.maxFrames,
      maxSeconds: V.maxSeconds,
    });
    const mode = V.mode === 'each' ? 'each' : 'sheet';
    const cols = Number(V.sheetCols) || 5;
    const rows = Number(V.sheetRows) || 4;
    const files = await extractFrames({ ffmpeg: binFf, input: file, outDir: join(dir, 'f'), plan, mode, opts: V, timeoutMs: 120000 });
    if (!files.length) throw new Error('没抽出画面');
    // ③ 逐张问视觉模型（软截止时间到了就用已有的收尾）
    const parts = [];
    for (const [i, f] of files.entries()) {
      if (Date.now() > deadline) {
        log.warn?.(`[视频] 到软截止时间了，用前 ${parts.length} 张收尾`);
        break;
      }
      let b64 = '';
      try {
        b64 = readFileSync(f).toString('base64');
      } catch {
        continue;
      }
      const span =
        mode === 'each'
          ? { from: i * plan.intervalSec, to: (i + 1) * plan.intervalSec }
          : sheetSpan(i, { frames: plan.frames, intervalSec: plan.intervalSec, perSheet: cols * rows });
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await ask(state, {
          prompt: videoPrompt(question, { mode, frames: plan.frames, intervalSec: plan.intervalSec, cols }),
          imageBase64: b64,
          mime: 'image/jpeg',
          maxTokens: mode === 'each' ? VIDEO_DEFAULTS.perFrameTokens : VIDEO_DEFAULTS.perSheetTokens,
          temperature: 0.2,
        });
        parts.push({ kind: mode === 'each' ? 'frame' : 'sheet', index: i, ...span, text: r?.text ?? '' });
      } catch (err) {
        log.warn?.(`[视频] 第 ${i + 1} 张读图失败：${err.message}`);
      }
    }
    const timeline = buildTimeline(parts);
    if (!timeline) return '';
    const mmss = (s) => `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒`;
    log.info?.(`[视频] 看了 ${plan.frames} 帧（${mode === 'sheet' ? `${files.length} 张拼图` : '逐帧'}）：${timeline.replace(/\n/g, ' / ').slice(0, 160)}`);
    return (
      `（时长 ${dur > 0 ? mmss(dur) : '未知'}，共抽了 ${plan.frames} 帧` +
      `${plan.truncated ? `，只看了前 ${mmss(plan.seconds)}` : ''}；**没有声音信息**）\n${timeline}`
    );
  } catch (err) {
    log.warn?.(`[视频] 处理失败（不影响聊天）：${err.message}`);
    return '';
  } finally {
    // 临时文件一定要清（视频可能几十 MB）
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 把一张 QQ 图片下载下来转成 base64。
 *
 * OneBot 的 image 段里 `url` 是 QQ 的图片直链（优先用它）；`file` 可能是文件名，
 * 也可能是 `base64://…`（本地表情包走这条）。
 *
 * ⚠️ **2026-10-11 修的真 bug**：签名里**漏了 `log`** —— 调用方明明是
 * `fetchImageAsBase64(img, { timeoutMs, log })`，而这里只解构了 `{ timeoutMs, retry }`，
 * 函数体里却用 `log?.warn?.(...)`。这个函数是**模块级**的（不在 `startBot` 的词法作用域里），
 * 所以 `log` 根本不存在 → **一走到失败/重试分支就抛 `log is not defined`**，整张图读不出来。
 * 日志实证（2026-10-10 三次）：`[warn] 读图失败：log is not defined` ——
 * 当时只会被当成"识图不准"，其实是代码炸了。
 * 现在：`log` 收进签名（默认 console），并**导出去**，好让自测能直接打这条失败路径。
 */
export async function fetchImageAsBase64(img, { timeoutMs = 30000, retry = 1, log = console } = {}) {
  /**
   * ⚠️ 2026-10-09 用户报「读图也有问题」：日志里是 `读图失败：This operation was aborted` ——
   * **QQ 的图片下载 15 秒超时**（大图/网络慢时必炸，跟识别准不准无关）。
   * 现在：默认给到 **30 秒**，并且**失败自动重试一次**；成功失败都记一行（含大小/耗时），
   * 免得下次又只能靠猜。
   */
  if (img?.url) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(img.url, {
          signal: ctrl.signal,
          headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://qq.com/' },
        });
        if (!res.ok) throw new Error(`下载图片 HTTP ${res.status}`);
        const mime = (res.headers.get('content-type') ?? '').split(';')[0] || 'image/jpeg';
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) throw new Error('图片是空的');
        if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片太大（${Math.round(buf.length / 1024)}KB）`);
        return { buffer: buf, base64: buf.toString('base64'), mime };
      } catch (err) {
        lastErr = err;
        // ⚠️ 超时是**最常见的失败**（QQ 图床大图慢）：记一行、再来一次
        log?.warn?.(
          `[识图] 下载图片失败（第 ${attempt + 1}/${retry + 1} 次，${Date.now() - t0}ms）：${err.message}${attempt < retry ? ' → 重试一次' : ''}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new Error('下载图片失败');
  }
  /**
   * **本地文件**（2026-10-14 加，为 TG）：
   * TG 的图拿不到公网 URL ✗（要带 token 走 getFile ✓），所以传输层会先把图**下到本地** ✓
   * 再把段写成 file://路径 ✓。这里直接读盘 —— 比再经一次网络快，也不会因为图片过期失效 ✗。
   */
  if (typeof img?.file === 'string' && img.file.startsWith('file://')) {
    const p = img.file.replace(/^file:\/\//, '');
    try {
      const buf = await fsp.readFile(p);
      if (!buf.length) throw new Error('本地图片是空的');
      if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片太大（' + Math.round(buf.length / 1024) + 'KB）');
      const ext = String(p).toLowerCase();
      const mime = ext.endsWith('.png') ? 'image/png' : ext.endsWith('.webp') ? 'image/webp' : ext.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
      return { buffer: buf, base64: buf.toString('base64'), mime };
    } catch (err) {
      throw new Error('读本地图片失败（' + p + '）：' + err.message);
    }
  }
  if (typeof img?.file === 'string' && img.file.startsWith('base64://')) {
    const b64 = img.file.slice('base64://'.length);
    return { buffer: Buffer.from(b64, 'base64'), base64: b64, mime: 'image/jpeg' };
  }
  throw new Error('这个 image 段里没有可用的地址（既没有 url，也不是 base64://）');
}

/**
 * 让模型「看」图：把画面转成一段中文描述，再拼进这一轮的用户消息。
 *
 * 为什么用「转文字」而不是直接发多模态消息：`llm.mjs` 的 `chat()` 是纯文本接口，
 * 改它要动整条工具调用链；而 `askWithImage()` 已经存在且实测可用，
 * 而且转成文字能一并写进会话历史——**下一轮它还记得图里有什么**。
 *
 * 读图失败**不允许让整轮失败**，返回带说明的占位串即可。
 */
/** 打包模式的关键词（用户说「打包 / 整本 / 所有页」这类）。纯函数，自测钉过（导出让自测能直接调）。 */
/**
 * **是否想打包**（纯函数 ✓）。
 *
 * ⚠️⚠️ **2026-10-15：把昨天加的"错别字容错"从这里撤掉了** ✗（用户报「聊天逻辑割裂」之后查出来的）。
 *
 * 经过（都拿他当晚的原话实测过 ✓）：加了滑窗式容错之后，
 * ```
 * 「好啦，处理完**所有**的事了…」  → 命中「所有页」（差 1 个字）✗ ⇒ 误判要打包
 * 「我想打**牌**」               → 命中「打包」✗
 * 「**压力**好大」               → 命中「压缩」✗
 * 「这张图的**所有部**分都不清楚」 → 命中「所有页」（差 1）✗
 * ```
 * ⇒ 这些轮次被**劫持到"打包发图"那条代码路径** ✓，她的回复于是**答非所问、上下文割裂** ✓✓
 * —— 这正是用户感觉"今晚聊天逻辑有问题"的真因 ✓。
 *
 * **判断改过来了**：
 *   · **"包含即算"的关键词不允许模糊** ✗ —— 中文短词差一个字就是**另一个常用词** ✓，
 *     滑窗式容错在这里**必然误伤** ✓（"误报的代价只是多发一次文件"是我昨天想当然 ✗，实际是**换掉整轮回复** ✓）；
 *   · 容错只保留在**整句锚定**的场景（`src/commands.mjs` ✓：整条消息只差一个字才算 ✓，
 *     比如「群列标」⇒「群列表」✓，而普通聊天绝不会整句≈命令 ✓）；
 *   · **他打错「打包」怎么办**？—— 那就走**普通聊天** ✓：模型自己看得懂错别字 ✓，
 *     她会用嘴问一句"你是要我打包吗" ✓，**这比劫持整轮强得多** ✓。
 */
/**
 * **当前传输层"主人私聊"的目标**（2026-10-18 抽出来的，因为同一个错犯了两次 ✗）。
 *
 * 事故记录：`state.master.users[0]` 是 **QQ 时代**的第一个主人（`10000000`）✗ ——
 * 在 Telegram 上拿它当 `chat_id`，就是 `Bad Request: chat not found` ✓。
 *   ① 2026-10-15：`runProactive`（主动开口）遍历 sessions 时踩到 ✓；
 *   ② 2026-10-18：`surfOnce`（自己冲浪）直接取 `.users[0]` 又踩了一次 ✓（日志里 89 条 chat not found ✗）。
 *
 * **规矩**：凡是"主动发消息给主人"的路径，**一律用这个函数** ✓，不要再自己取 `master.users[0]` ✗。
 *
 * @returns {{id:string, key:string, target:{type:'private', id:string}}|null}
 */
export function masterTargetOf(state) {
  if (state?.transport === 'telegram') {
    const tg = String(state?.telegram?.masterUserId ?? '').trim();
    if (!tg) return null; // 还没认领主人 ⇒ 宁可不发，也不要发错人
    return { id: tg, key: `private:${tg}`, target: { type: 'private', id: tg } };
  }
  const qq = String((state?.master?.users ?? [])[0] ?? '').trim();
  if (!qq) return null;
  return { id: qq, key: `private:${qq}`, target: { type: 'private', id: qq } };
}

export function wantsZipPack(text) {
  return /打包|压缩|压成|zip|ZIP|整本|全部页|所有页|所有图|每一页|一整套|整套|打成一包|发文件/i.test(String(text ?? ''));
}

/**
 * 打包（zip）的两道上限 —— **宁可先说"太大/太多"，也不要下到一半把内存或磁盘撑爆**。
 * 一个 pixiv 长篇漫画动辄上百页、原图每页几 MB，所以两个都要卡。
 */
const PACK_MAX_PAGES = 60;
const PACK_MAX_BYTES = 200 * 1024 * 1024;

/** 打包时要落盘的目录（发完就留着，下次同名会覆盖；顺手清掉两天前的）。 */
const PACK_DIR = resolve(ROOT, 'logs/packs');
function cleanOldPacks({ keepDays = 2 } = {}) {
  try {
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
    for (const f of readdirSync(PACK_DIR)) {
      const p = resolve(PACK_DIR, f);
      try {
        const st = statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* 单个文件删不掉就算了 */
      }
    }
  } catch {
    /* 目录不存在等情况忽略 */
  }
}

/**
 * **把一个 pixiv 作品打成 zip 发过去**（2026-10-11 用户要的「漫画下载 → 压成 zip」）。
 * 命名按用户指定的格式：`pid_作者_时间_部分标签.zip`（见 `pixivZipName`）。
 */
async function sendPixivPack(target, key, id, askText = '', log = console) {
  const work = await fetchPixivWork(id);
  const total = Math.max(1, Number(work.pageCount) || 1);
  if (total > PACK_MAX_PAGES) {
    return `这个作品有 **${total} 页**，超过我一次打包的上限（${PACK_MAX_PAGES} 页）—— 说具体页码或者换个短篇吧。`;
  }
  const pages = await fetchPixivPages(id, { maxPages: PACK_MAX_PAGES });
  log.info(`[打包] 作品 ${work.id}（${work.author || '佚名'}）共 ${pages.length} 页 → 开始逐页下载`);
  const entries = [];
  let bytes = 0;
  let failed = 0;
  for (const p of pages) {
    try {
      const buf = await fetchPixivImage(p.url);
      bytes += buf.length;
      if (bytes > PACK_MAX_BYTES) {
        return `下到第 ${p.page + 1} 页就超过体积上限（${Math.round(PACK_MAX_BYTES / 1048576)}MB）了，先不打包了（避免撑爆）。`;
      }
      const ext = (String(p.url).match(/\.(jpe?g|png|gif|webp)(?:\?|$)/i)?.[1] ?? 'jpg').toLowerCase();
      entries.push({ name: `${String(p.page + 1).padStart(3, '0')}.${ext}`, data: buf });
    } catch (err) {
      failed += 1;
      log.warn(`[打包] 第 ${p.page + 1} 页下载失败：${err.message}`);
    }
  }
  if (!entries.length) return `这个作品的图我一张都没下下来（${failed} 页全失败）—— 多半是代理/R-18 登录的问题，看日志。`;

  const name = pixivZipName({
    id: work.id,
    author: work.author,
    date: work.createDate,
    tags: work.tags,
    askedTags: parseTagQuery(askText).tags,
  });
  const buf = makeZip(entries);
  mkdirSync(PACK_DIR, { recursive: true });
  const file = resolve(PACK_DIR, name);
  writeFileSync(file, buf);
  cleanOldPacks();

  const up = await onebot.uploadFile(target, { file, name });
  log.info(
    `[打包] ${name}（${entries.length} 页 / ${Math.round(buf.length / 1024)}KB${failed ? `，${failed} 页没下到` : ''}）→ ${up.ok ? '已发送' : `发送失败：${up.detail}`}`,
  );
  if (!up.ok) {
    /**
     * 发文件失败就**退回发第一张图**（用户至少拿到点东西），并在回复里说清是哪种失败
     * —— 别学 2026-10-10 那条"冤枉 NapCat"的文案。
     */
    const first = entries[0];
    const ok = await onebot.trySendRich(target, [{ type: 'image', file: `base64://${first.data.toString('base64')}` }]);
    return (
      `打包好了（${entries.length} 页，${name}），但**发文件这一步失败了**（${up.detail}）` +
      (ok ? '，我先发第一页给你看看。' : '，连第一页也没发出去。')
    );
  }
  return (
    `打包发出：**${name}**（${entries.length} 页${failed ? `，另有 ${failed} 页没下到` : ''}）。` +
    `**顺便把出处报给用户**：作品 ${work.id}（${work.author || '佚名'}）${work.title ? `「${work.title}」` : ''}　${work.pageUrl}`
  );
}

/**
 * **按 pixiv 作品号直接下载并发出去**（2026-10-10 用户要求），并**说明作者/作品号**。
 * 群里也允许（用户没限制这一条），但 R-18 的图本来也需要登录 cookie 才拿得到。
 *
 * ⚠️ **2026-10-11**：`askText` 里出现「打包/整本/所有页」这类词时走 `sendPixivPack()`（zip）。
 */
async function sendPixivWork(target, key, id, askText = '', log = console) {
  try {
    if (wantsZipPack(askText)) {
      const r = await sendPixivPack(target, key, id, askText, log);
      await say(target, key, r, '小笛·找图');
      return r;
    }
    const work = await fetchPixivWork(id);
    const buf = await fetchPixivImage(work.url);
    const ok = await onebot.trySendRich(target, [{ type: 'image', file: `base64://${buf.toString('base64')}` }]);
    if (!ok) return '图下下来了，但发不出去（NapCat 那边失败）';
    const info =
      `作品 **${work.id}**` +
      `
作者：**${work.author || '佚名'}**` +
      (work.title ? `
标题：${work.title}` : '') +
      (work.tags.length ? `
标签：${work.tags.slice(0, 6).join('、')}` : '') +
      `
原地址：${work.pageUrl}`;
    await say(target, key, info, '小笛·找图');
    return `发出作品 ${work.id}（by ${work.author || '佚名'}）`;
  } catch (err) {
    return `没取到：${err.message}`;
  }
}

/** 角色表（昵称 → 正式名/出处）。放 logs/，自动维护，不用手改。 */
const CHARACTER_MAP_FILE = resolve(ROOT, 'logs/character-map.json');
function readCharacterMap() {
  try {
    return JSON.parse(readFileSync(CHARACTER_MAP_FILE, 'utf8')) ?? {};
  } catch {
    return {};
  }
}
function writeCharacterMap(key, value, log = console) {
  try {
    const all = readCharacterMap();
    all[String(key)] = value;
    mkdirSync(dirname(CHARACTER_MAP_FILE), { recursive: true });
    writeFileSync(CHARACTER_MAP_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8');
  } catch (err) {
    log.warn(`[找图] 角色表写入失败：${err.message}`);
  }
}

/**
 * **漏网的"像是在要图"记一份档**（2026-10-10 用户要求）：
 * 正则没接管时，把那句话按行追加进 `logs/intent-misses.jsonl`，
 * 我定期收网 → 补规则。**不自动改规则**：自动加会越长越乱、还容易误伤。
 */
const INTENT_MISS_FILE = resolve(ROOT, 'logs/intent-misses.jsonl');
function appendIntentMiss({ text, scope, key }, log = console) {
  try {
    mkdirSync(dirname(INTENT_MISS_FILE), { recursive: true });
    appendFileSync(INTENT_MISS_FILE, JSON.stringify({ at: Date.now(), scope, key, text: String(text).slice(0, 120) }) + "\n", "utf8");
  } catch (err) {
    log.warn(`[找图] 漏网记录写入失败：${err.message}`);
  }
}

/** 找图那份"近期发过的图"（跨会话、带时间窗）。 */
const SENT_IMAGE_FILE = resolve(ROOT, 'logs/sent-images.json');
const SENT_IMAGE_WINDOW_MS = 24 * 3600 * 1000;

/**
 * **发之前先筛一遍**（用户 2026-10-09：「识图先筛一遍，别啥都往外发」）。
 * 只问一个问题、只要一个字，所以很便宜；拿不准/接口失败时**放行**（别让抽风把图卡死）。
 *
 * ⚠️ **2026-10-10 用户实测的两个问题都在这道闸上**（详见 `src/vision.mjs` 的 `screenAsk`）：
 *   ① 提示词**没说场景** —— 主人的私聊里 R-18 是允许的，模型却因为露骨把 `artworks/150672152` 筛掉了；
 *   ② 只回「合适/不合适」**没有理由** —— 日志里看不出为什么被筛掉（这次靠用户反查作品标签才发现）。
 * 现在：`allowR18` 由调用方按场景传入（主人的私聊 = true），回答里的理由会一起打进日志。
 */
async function screenImageForSend(state, img, query, { log = console, allowR18 = false, exclude = [] } = {}) {
  if (state.imageSearch?.screen === false) return true;
  if (!img?.buf?.length) return false;
  try {
    const out = await askWithImage(state, {
      prompt: screenAsk({
        query,
        allowR18,
        tags: img?.tags ?? [],
        xRestrict: img?.xRestrict ?? 0,
        exclude,
      }),
      imageBase64: img.buf.toString('base64'),
      mime: 'image/jpeg',
      // 结论 + 理由（≤20 字）要比以前多花几个 token，给到 40 不会截断理由。
      maxTokens: 40,
      temperature: 0,
    });
    const { ok, reason } = parseScreenVerdict(out?.text);
    if (!ok) {
      /**
       * ⚠️ 2026-10-10 用户要自己去看"为什么被筛掉"：原来记的是 **i.pximg 的 CDN 地址**
       * （得带 Referer 才打得开 ✗）。改成记**作品页**（能直接点开看）+ 它自己的标签 + 模型给的理由。
       */
      log.info?.(
        `[找图] 筛掉一张（${reason || '它没说理由'}；场景=${allowR18 ? '主人私聊·R-18允许' : '群/别人·分级也管'}）：` +
          `${String(img.page ?? img.url).slice(0, 90)}` +
          (Array.isArray(img.tags) && img.tags.length ? ` 标签=${img.tags.slice(0, 6).join('/')}` : '') +
          (Number(img.xRestrict) >= 1 ? ` xRestrict=${Number(img.xRestrict)}` : ''),
      );
    }
    return ok;
  } catch (err) {
    log.warn?.(`[找图] 筛图失败（放行）：${err.message}`);
    return true;
  }
}

export async function describeImages(state, images, { max = 2, log = console, question = '', ask = askWithImage, fetchImage = fetchImageAsBase64, identify = identifyImage } = {}) {
  /**
   * ⚠️ **同一条消息里的重复图只读一次**（2026-10-12）：
   * 合并窗口曾经把"已经渲染成 `[图片]` 的文本"和"真实图片段"一起塞进合成消息，
   * 于是**一张图被读两遍**（用户报「我发图他为啥识别两张」）。那个根源已修，
   * 这里再加一道**按 url/file 去重**的保险 —— 同一张图重复出现（同 URL）不再读第二次。
   */
  const seen = new Set();
  const picked = [];
  for (const img of images) {
    const key = String(img?.url ?? '') || String(img?.file ?? '');
    if (key && seen.has(key)) {
      log.info?.('[识图] 同一张图重复出现 → 只读一次');
      continue;
    }
    if (key) seen.add(key);
    picked.push(img);
    if (picked.length >= Math.max(1, max)) break;
  }
  const parts = [];
  for (const img of picked) {
    try {
      let { buffer, base64, mime } = await fetchImage(img, { timeoutMs: state.vision?.imageTimeoutMs ?? 30000, log });
      /**
       * ⚠️ **发之前先把大图压小**（2026-10-12）：
       * 日志实证当天两次读图都废了 —— 一次模型返回空、一次 **60 秒超时**，
       * 共同原因是 QQ 原图太大（几 MB，base64 还要再涨 1/3）。
       * 压到 1280px 宽（实测 683KB → 53KB，省 92%）既省上传时间，
       * **又不丢细节** —— 2026-10-11 的对照实验里，单帧 1280px 能准确读出 20px 的小水印。
       */
      if (state.vision?.shrink !== false && buffer.length > (Number(state.vision?.shrinkAboveBytes) || 600 * 1024)) {
        const r = await shrinkImage(buffer, {
          maxWidth: Number(state.vision?.maxWidth) || 1280,
          tmpDir: join(LOG_DIR, 'vision-tmp'),
          ffmpeg: String(state.video?.ffmpeg ?? ''),
        });
        if (r.shrank) {
          log.info?.(`[识图] 缩图 ${Math.round(r.from / 1024)}KB → ${Math.round(r.to / 1024)}KB（${Math.round((1 - r.to / r.from) * 100)}%）`);
          buffer = r.buffer;
          base64 = r.buffer.toString('base64');
          mime = r.mime;
        } else if (r.note && !/没找到 ffmpeg|没给临时目录/.test(r.note)) {
          log.warn?.(`[识图] 缩图跳过：${r.note}`);
        }
      }
      /**
       * ⚠️ **压不小就别发了**（2026-10-13 实测加，避免白等 60 秒）：
       *
       * 实测（真 API，同一张 1038KB 的图）：**原图 60 秒超时**（有一次走运 58.7 秒），
       * 而缩到 89KB 后 **6~8 秒**就回来了、且认得一样准 ✓。
       * ⇒ 缩图**失败/跳过**时若还硬发原图，等于把回复卡满 60 秒 ✗（用户看到的是"一片糊/读不出来"）。
       * 所以超过 `skipAboveBytes`（默认 900KB）又没压小 ⇒ **直接不发这次识图**，
       * 给模型一句**能照实说**的话，让它当场告诉主人"图太大我读不动" ✓（好过干等一分钟 ✗）。
       */
      const tooBig = buffer.length > (Number(state.vision?.skipAboveBytes) || 900 * 1024);
      if (tooBig && !(state.vision?.shrink !== false && buffer.length <= (Number(state.vision?.shrinkAboveBytes) || 600 * 1024))) {
        log.warn?.(`[识图] 图太大（${Math.round(buffer.length / 1024)}KB）且没能压小 —— 这次不读了，直接告诉她`);
        parts.push(`（他这张图有 ${Math.round(buffer.length / 1024)}KB，我这边压不小也读不动 —— 如实告诉他"图太大了我读不出来，能不能发小一点的或者截一下"）`);        continue;
      }

      // 视觉描述与「认角色」**并行**：溯源要几秒，不该拖住描述。
      // ⚠️ 2026-10-14：认角色从"只用 trace.moe"换成 `identifyImage`（trace.moe + SauceNAO + 置信度 ✓）。
      // 为什么：用户要"提高动漫角色成功率"，而实测单看任何一个源都会给**像样的错答案**
      // （他真机那张少女前线的 3D 渲染：trace.moe 82.8% 说 Zombie-Loan、SauceNAO 36% 说 Yuudachi，两个都错）。
      // 换成聚合之后，那种情况会返回 `null` 或 `low` ⇒ 她老老实实说"认不出"，而不是编 ✗。
      const wantTrace = state.vision?.identifyAnime !== false;
      const [descR, identR] = await Promise.allSettled([
        /**
         * ⚠️ **识图调用也要重试**（2026-10-12）：当天有一次模型直接返回空内容
         * （日志：`（这张图模型没说出内容）`）。重试一次基本能救回来 ——
         * 复用 llm.mjs 里那条通用的 `withRetry`（网络/超时/5xx 重试，401 不重试）。
         */
        withRetry(
          () =>
            ask(state, {
              // 把他的问题带进去 → 视觉模型**针对问题**看图，而不是泛泛描述（2026-10-11）
              prompt: visionPrompt(question),
              imageBase64: base64,
              mime,
              maxTokens: 300,
              temperature: 0.2,
            }),
          { maxAttempts: 2, log, label: '识图' },
        ),
        wantTrace ? identify(buffer) : Promise.resolve(null),
      ]);

      const desc = descR.status === 'fulfilled' ? String(descR.value?.text ?? '').trim() : '';
      const ident = identR.status === 'fulfilled' ? identR.value : null;
      if (descR.status === 'rejected') log.warn?.(`读图失败：${descR.reason?.message ?? descR.reason}`);

      let line = desc || '（这张图模型没说出内容）';
      // ⚠️ **识图结果必须落盘**（2026-10-09 用户说"看群里日志"时我才发现这里压根没记）：
      //    不记的话，出了"认错人"这种问题只能靠翻会话猜。别打印整段 base64，只打印它看到的文字。
      log.info?.(`[识图] ${line.replace(/\n/g, ' / ').slice(0, 160)}`);
      /**
       * 溯源结果**另起一行并标明来源**，并且**带上置信度口径** ✓ ——
       * 模型写回复时才知道该说「这应该是《XX》」还是「可能是」还是**别说** ✗。
       */
      if (ident) {
        line += `\n【以图搜图】\n${ident.text}`;
        line +=
          ident.confidence === 'high'
            ? '\n（上面相似度很高，可以说成「应该是」✓）'
            : ident.confidence === 'medium'
              ? '\n（相似度中等 —— 只能说「可能是」，别当成事实 ✓）'
              : '\n（**相似度太低、不算数** ✗：不许把它们当结论说出来；就当自己也没认出来，只报画面里看得见的东西 ✓）';
        log.info?.(
          `[识图] 以图搜图：置信度=${ident.confidence} 最高=${(ident.top * 100).toFixed(1)}% ｜ ` +
            ident.text.replace(/\n/g, ' ｜ ').slice(0, 150),
        );
      } else if (wantTrace) {
        log.info?.('[识图] 以图搜图：两个源都没到门槛（这就是"认不出" ✓ 别硬猜）');
      }
      parts.push(line);
    } catch (err) {
      log.warn?.(`读图失败：${err.message}`);
      parts.push(`（有一张图没读出来：${err.message}）`);
    }
  }
  return parts.join('\n');
}

/**
 * 从一段文本里抠出 B站 链接（含 `b23.tv` 短链）。
 *
 * **为什么要由代码来抠**：实测模型**不会**主动调 `bilibili_video` ——
 * 用户发一条「【视频标题】 https://b23.tv/xxx」，它直接拿消息里现成的**标题**就答了，
 * 1450ms 回完，还替自己编了句「短链不给内容」。可那条短链实测完全能解析
 * （302 的 Location 里就是 BV1T1te6mEF2），工具跑出来连弹幕和画面都有。
 *
 * 所以「链接」这件事和「读图」一样：**由代码保证，不指望模型想起来**。
 * 一条消息只取**第一个** —— 免得一条消息里十个链接就发十次请求。
 */
function findBiliLinks(text) {
  const re = /https?:\/\/(?:www\.)?(?:bilibili\.com\/video\/[A-Za-z0-9]+|b23\.tv\/[A-Za-z0-9]+)/gi;
  return [...String(text ?? '').matchAll(re)].map((m) => m[0]).slice(0, 1);
}

function acquireLock() {
  try {
    const old = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (old?.pid && old.pid !== process.pid) {
      try {
        process.kill(old.pid, 0); // 只探活，不发信号
        return { ok: false, holder: old };
      } catch {
        /* 持有者已经不在，锁可以接管 */
      }
    }
  } catch {
    /* 没有锁文件，或内容坏了，直接接管 */
  }
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  } catch {
    /* 锁写不进去也不该阻止启动 */
  }
  return { ok: true };
}

function releaseLock() {
  try {
    const cur = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (cur?.pid === process.pid) rmSync(LOCK_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
}

export function createLogger({ toFile = true, level = 'info' } = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = levels[level] ?? 20;
  if (toFile) {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
    } catch {
      /* 日志目录建不出来也不该拖垮机器人 */
    }
  }
    // ⚠️ 文件名也用**本地日期** ✓（跟每一行的时间戳对齐 ✓，否则凌晨会"今天的文件装昨天的行" ✗）
  const file = resolve(LOG_DIR, `bot-${localDateStamp()}.log`);

  const emit = (lvl, msg) => {
    if (levels[lvl] < min) return;
    const line = `${localStamp()} [${lvl}] ${msg}`;
    console[lvl === 'debug' ? 'log' : lvl](line);
    if (toFile) {
      try {
        appendFileSync(file, line + '\n');
      } catch {
        /* 忽略 */
      }
    }
  };

  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    file,
  };
}

/**
 * 把「文本 + 图片」段数组转成可发送的形式。
 *
 * 读不出来的图片**就地丢掉、只留文字**，绝不把整条回复带崩——
 * 表情包目录是用户随时会动的，模型手里的标签可能已经过期。
 */
export function buildRichSegments(segments, onMissing) {
  const out = [];
  for (const s of segments) {
    if (s.type === 'voice') continue; // 语音是单独一条消息，由调用方负责发
    if (s.type === 'music') {
      // 已经解析出 songmid 的才发。主动开口那条路径没做解析（模型不该自己点歌），
      // 这里直接丢掉，免得发出一个残缺的音乐段。
      // title/singer/url/image 必须一起带上——NapCat 的签名服务要这些字段。
      if (s.songmid) {
        out.push({
          type: 'music',
          songmid: s.songmid,
          title: s.title,
          singer: s.singer,
          url: s.url,
          image: s.image,
        });
      }
      continue;
    }
    if (s.type === 'webimage') {
      // 网图：直接把 URL 交给 NapCat 让它去下载。URL 已经过白名单与内网防护。
      out.push({ type: 'image', file: s.url });
      continue;
    }
    if (s.type !== 'image') {
      out.push(s);
      continue;
    }
    const file = toBase64UrlOrNull(s.path);
    if (file) out.push({ type: 'image', file });
    else onMissing?.(s.path);
  }
  return out;
}

/**
 * 起一个机器人。返回句柄，方便测试里停掉它。
 * 这一层只做编排：OneBot 适配器 -> 触发规则 -> 上下文 -> 大模型 -> 发回去。
 *
 * 配置是**热重载**的：config.json 一变（例如你在控制面板里点了保存），
 * 下面的 state 会原地更新。router 与 llm 持有的是同一个对象引用，
 * 所以改人格、白名单、触发方式、模型后端都**不需要重启**。
 */
export function startBot(config, { log = createLogger(), status = true } = {}) {
  const state = { ...config };
  /**
   * **传输层归一**（2026-10-14）：默认还是 QQ（行为不变 ✓）。
   * 选 TG 时把 Telegram 的 masterUserId 并进 state.master.users ——
   * 这样**人格/称呼/记忆/工具权限那一整套判定一行都不用改** ✓（它们全都只看 state.master.users ✓）。
   */
  state.transport = state.transport === 'telegram' ? 'telegram' : 'onebot';
  if (state.transport === 'telegram') {
    const tgMaster = String(state.telegram?.masterUserId ?? '').trim();
    if (tgMaster) {
      state.master = { ...state.master, users: [...new Set([...(state.master?.users ?? []).map(String), tgMaster])] };
      /**
       * ⚠️ **白名单也要有他**（2026-10-14 真机踩到 ✓）：
       * 私聊触发读的是 **`whitelist.users`**（`router.mjs` ✓），而它**本来只装 QQ 号** ✗ ——
       * 于是 TG 的你**收得到、归档得到，但路由器判「不在白名单」⇒ 她一个字都不回** ✗✗（
       * 而且那条理由是 debug 级、默认看不见 ✗，所以从日志上看就是"凭空没反应" ✓）。
       * 现在：选了 TG 就把 TG 主人**自动补进白名单** ✓。
       */
      state.whitelist = { ...(state.whitelist ?? {}), users: [...new Set([...(state.whitelist?.users ?? []).map(String), tgMaster])] };
      log.info('[tg] 主人已按配置绑定：' + tgMaster + '（白名单也补上了 ✓）');
    } else {
      log.warn('[tg] 还没配主人 id —— 第一次私聊我的人会被当成主人（我会把那个 id 打进日志，你确认一下）');
    }
  }
  // ⚠️ `ownIdsFile`：把"我发过哪些消息"落盘 —— 群里**引用她的消息**才算被叫，
  //    而这份 id 表以前只在内存里（重启就忘，用户今天重启了 5 次）＋**纯文本发送压根没记**，
  //    于是"引用她的文字回复"在群里等于空气（2026-10-09 用户报「引用的逻辑还有点问题」）。
  /**
   * **7 天聊天归档**（2026-10-11 用户要求，实现见 `src/chatlog.mjs`）。
   *
   * 三件事在这里定下来：
   *   ① 文字档与**图片目录可以分盘**（图片默认跟随 `dir`，用户那块 4T 挂上后填 `mediaDir` 即可）；
   *   ② 记账**永远不挡消息**：文字行同步写，图片进后台队列（`recordIncoming` 不 await 图片）；
   *   ③ 启动就清一次超期档（`prune`），之后挂到已有的 10 分钟清扫器上。
   */
  const archiveCfg = state.chatArchive ?? {};
  const chatArchive =
    archiveCfg.enabled === false
      ? null
      : new ChatArchive({
          dir: resolve(ROOT, String(archiveCfg.dir ?? '小笛记忆')),
          mediaDir: archiveCfg.mediaDir ? resolve(String(archiveCfg.mediaDir)) : '',
          /**
           * **本地暂存**（用户以后要用 iSCSI 挂 NAS：网络盘开机可能没挂上、中途会掉）——
           * 那期间的记录先写这里、等盘回来自动搬过去。**必须落本地盘**（默认 `<dir>-spool`）。
           */
          spoolDir: archiveCfg.spoolDir ? resolve(ROOT, String(archiveCfg.spoolDir)) : '',
          ttlDays: Number(archiveCfg.ttlDays) === 0 ? 0 : Number(archiveCfg.ttlDays) || 7,
    recallDays: Number(archiveCfg.recallDays) || 7,
          saveMedia: archiveCfg.saveMedia !== false,
          maxMediaBytes: Number(archiveCfg.maxMediaBytes) || 8 * 1024 * 1024,
          maxVideoBytes: Number(archiveCfg.maxVideoBytes) || 20 * 1024 * 1024,
          maxDayMediaBytes: Number(archiveCfg.maxDayMediaBytes) || 50 * 1024 * 1024,
          maxTotalBytes: Number(archiveCfg.maxTotalBytes) || 2 * 1024 * 1024 * 1024,
          fetchMedia: fetchImageBytes,
          log,
        });
  if (chatArchive) {
    /**
     * ⚠️ **先迁移老布局**（2026-10-11 用户把结构改成 `小笛记忆/<日期>/记忆/<小时>`）：
     * 老结构是 `logs/chat/YYYY-MM-DD.jsonl`，直接换目录会把当天已有的记录"读不到"。
     * 迁移按每行自己的 `at` 归到小时档，老文件改名 `.migrated`（**不删**，可回溯）。
     */
    chatArchive
      .migrateLegacy()
      .then((m) => {
        if (m.moved) log.info(`[归档] 老布局迁移完成：${m.files.length} 个档 / ${m.moved} 行 → 小笛记忆/<日期>/记忆/`);
      })
      .catch((err) => log.warn(`[归档] 迁移老布局失败（不影响聊天）：${err.message}`));
    const pr = chatArchive.prune();
    log.info(
      `[归档] 7 天聊天归档已启用：文字档 ${chatArchive.dir}｜图片 ${chatArchive.mediaRoot}｜` +
        `${chatArchive.ttlDays > 0 ? `保留 ${chatArchive.ttlDays} 天（起点 ${pr.cutoff}）` : `**永久保留**（不清理，起点 ${pr.cutoff}）`}${pr.drop.length ? `，启动时清掉 ${pr.drop.join('/')}` : ''}`,
    );
  }
  /**
   * **同一个变量名，两种实现**（2026-10-14）：`Telegram` 对外暴露和 `OneBot` 一样的方法 ✓
   * （trySendRich / trySend / setInputStatus / isOwnMessage / on('event') / close ✓），
   * 事件形状也转成 OneBot 那套 ✓ ⇒ 下面几千行**一个字都不用改** ✓。
   */
  const onOutgoing = (target, segments, id) => chatArchive?.recordOutgoing({ target, segments, id });
  const onebot = state.transport === 'telegram'
    ? new Telegram({
        ...state.telegram,
        log,
        ownIdsFile: resolve(ROOT, 'logs/tg-own-ids.json'),
        spoolDir: resolve(ROOT, 'logs/telegram-spool'),
        onOutgoing,
      })
    : new OneBot({
    ...state.onebot,
    ownIdsFile: resolve(ROOT, 'logs/own-ids.json'),
    // 发出去的每条消息都记一笔（文本/富消息/文件上传全从 OneBot 出去，挂这里不会漏）
    // 发出去的每条消息都记一笔（文本/富消息/文件上传全从 OneBot 出去，挂这里不会漏）；
    // **带上 message_id**：这样别人引用小笛说的话时，归档能查回原文（不再只有个 id）
    onOutgoing: (target, segments, id) => chatArchive?.recordOutgoing({ target, segments, id }),
  });
  /**
   * **TG 主人自动认领**（2026-10-14）：配置里没写 masterUserId 时，
   * **第一个私聊我的人**的主人 —— 只认一次 ✓，并打一行醒目日志让你核对 ✓
   * （TG 上别人得先知道 bot 的用户名才找得到，所以这个默认是安全的 ✓）。
   */
  if (state.transport === 'telegram' && onebot?.on) {
    onebot.on('event', (evt) => {
      if (state.__tgMasterLearned) return;
      if (String(state.telegram?.masterUserId ?? '').trim()) return;
      if (evt?.message_type !== 'private') return;
      const uid = String(evt?.user_id ?? '');
      if (!uid) return;
      state.__tgMasterLearned = true;
      state.master = { ...state.master, users: [...new Set([uid])] };
      log.warn('[tg] **把第一个私聊我的人认成主人**：' + uid + '（昵称 ' + String(evt?.sender?.nickname ?? '') + '）—— 如果这不是你，去 config.json 的 telegram.masterUserId 改掉 ✓');
    });
  }
  const llm = createLLM(state, { log });
  const toolChat = createToolChat(state, { log });

  /**
   * 当前允许的工具。enabledTools 为空表示全开。
   *
   * **只在 deepseek 这条链路上给工具**：目前只有它接了 function calling。
   * 不加这个判断的话，toolChat 会绕过 provider 抽象直接打 DeepSeek——
   * 自测里配 echo 也照样走线上模型（真实被测试抓过一次）。
   *
   * ⚠️ **控制类工具只在「私聊 + 主人」时注入**（`ctx` 由调用方从事件里现算）。
   * 这是"群里连工具定义都看不到"的实现点 —— 不是拦，是**没有入口**。
   */
  function activeTools(ctx = null, { withControl = true } = {}) {
    if (!state.tools?.enabled) return [];
    if (state.llm.provider !== 'deepseek') return [];
    const allow = (state.tools.enabledTools ?? []).map(String);
    const base = allow.length ? TOOL_DEFS.filter((d) => allow.includes(d.function.name)) : TOOL_DEFS;
    // 意图路由已经替它做过的那一轮，要把控制类工具收回去（防同一个开关被按两次）
    return withControl ? toolsForContext(base, state, ctx) : [...base];
  }
  const sessions = new Sessions({
    historyTurns: state.limits.historyTurns,
    ttlMs: state.limits.sessionTtlMs,
    maxChars: state.limits.sessionMaxChars,
    // 落盘：不然每次重启（改代码 / NapCat 挂了 / 关机）都是彻底失忆。
    file: state.limits.sessionFile ? resolve(ROOT, state.limits.sessionFile) : null,
  });
  if (sessions.size) log.info(`读回了 ${sessions.size} 个会话的上下文（${state.limits.sessionFile}）`);
  const router = createRouter(state, { isOwnMessage: (id) => onebot.isOwnMessage(id) });

  let stickers = loadStickers(state.stickers?.dir ?? 'stickers');

  // 梗库：可编辑的纯文本，改了就热更新（跟表情包库同一套思路，不用重启）
  let memes = loadMemes(state.llm?.memesFile ?? 'memes.md');
  let memesSeen = memes.mtime;

  /**
   * 目录指纹 = 目录本身 + 两份标签文件的 mtime。
   *
   * **只取目录 mtime 是不够的**：在同一个目录里改写 tags.json **不会改变目录的 mtime**
   * （只有增删文件才会）。于是"在面板上改一个标签"这件事机器人根本感知不到，
   * 得等下次有人加/删图片才顺带刷新——那就太玄学了。
   */
  function dirStamp() {
    try {
      const parts = [statSync(stickers.dir).mtimeMs];
      for (const f of [TAGS_VISION_FILE, TAGS_MANUAL_FILE]) {
        try {
          parts.push(statSync(join(stickers.dir, f)).mtimeMs);
        } catch {
          parts.push(0);
        }
      }
      return parts.join(':');
    } catch {
      return null;
    }
  }
  let stickersStamp = dirStamp();

  /**
   * 一次最多把多少个标签写进 prompt。
   * 这个值不是「越小越省」——标签没列出来的模型就永远选不到。
   * 实测 100 个中文标签约占 300 token，每条消息多花这点钱远不如让表情包能用起来划算。
   * 设 200 只是防呆：真到几百个唯一标签，多半是自动打标签没跑（文件名当标签了）。
   */
  const MAX_TAGS_IN_PROMPT = 200;

  /**
   * 只把「像给人看的」标签列进 prompt。
   *
   * 自动打标签失败的图片会退回用文件名当标签，而那些名字往往是
   * `1694307593293` / `a138e2ac7e1c…` / `IMG_20240305`。
   * 列给模型等于往候选里塞垃圾——它会随机点一个，用户收到一张毫不相关的表情包。
   */
  function offerableTags() {
    return stickers.tags.filter(isHumanTag);
  }

  /** 把表情包标签接进 system —— 模型得先知道有哪些标签，才谈得上「点单」。 */
  function composeSystem() {
    const offerable = offerableTags();
    const names = activeTools().map((d) => d.function.name);
    // 明确告诉它「你有工具」：否则它会先回一句「我查不到」再被纠正，白花一轮
    const toolHint = names.length
      ? `\n\n你还能用工具查实时信息（${names.join('、')}）。需要时**直接调工具**，不要说「我查不到」「我没有联网」。`
      : '';
    // 梗库：给它一个伸手可够的具体池子，比"你自己想想有什么梗"有用得多
    const memeHint = memes.text
      ? `\n\n【梗库】下面这些梗你可以直接用，**群里自己的梗优先**。别解释梗的意思，一次最多用一个：\n${memes.text}`
      : '';

    if (offerable.length === 0) return state.llm.system + toolHint + memeHint;

    const shown = offerable.slice(0, MAX_TAGS_IN_PROMPT);
    const more =
      offerable.length > shown.length ? `（一共 ${offerable.length} 个，这里列了前 ${shown.length} 个）` : '';
    return (
      // ⚠️ 2026-10-19：**表情包这一段必须放在最后** ✓（原来它后面还跟着 toolHint + memeHint ✗）。
      //    依据：拿真实标签+真实人格直接问模型 ⇒ **4/4 都吐 [[图:]]** ✓✓；带 6 轮历史也照样吐 ✓；
      //    唯一差的就是**顺序** ✓ —— 模型对"最后看到的东西"最敏感 ✓，所以把表情包挪到**末尾** ✓。
      `${state.llm.system}${toolHint}${memeHint}\n\n` +
      // ⚠️ 2026-10-19：用户要她「自己查攻略、会玩」+「会有喜欢的游戏」✓
      `【玩手机 / 玩游戏】\n` +
      `· 想玩某个游戏（蔚蓝档案、开心消消乐这类）**之前，先用 web_search 查一下怎么玩/当前攻略** ✓，` +
      `看懂规则再动手；攻略太长就只看前几条要点。（这一步很省，别跳过 ✓）\n` +
      `· 真要去玩：**先问主人一句**（"我想玩会儿 X，行吗"）✓ —— 他说"去/行/玩吧"才调 phone_play ✓。\n` +
      `· phone_play 会自己打开雷电模拟器 ✓；一次最多约 20 步 / 大约 1 块钱 ✓；玩完用你自己的话跟他说你干了啥 ✓。\n` +
      `· **你是有偏好的** ✓：玩到喜欢的游戏/关卡，用 memory_remember 记一句（"我喜欢玩 XX，因为…"）✓；` +
      `下次想玩时**优先挑你喜欢的** ✓，别每次随机。\n` +
      // 2026-10-19 用户问「他有没有自己练号练强度的思维」✓ ⇒ 给她一个**可执行的养成循环** ✓
      `· **练号/养成（重要 ✓）**：每次开玩之前，先看自己记忆里这个游戏的**进度**（推到第几关、缺什么素材）；` +
      `没有就**先定一个小目标**（"今天把这关推过去 / 把这件素材刷够"）✓，玩的时候**只奔这个目标** ✓；` +
      `玩完**必须把结果记进记忆**（"蔚蓝档案：现在 3-2 关，缺强化石"）✓ —— 下次就接着这个进度，` +
      `不然每次从零开始 ✓。\n` +
      // 2026-10-19 用户问「她搜攻略会搜配队/练角色吗」✓ ⇒ 会搜 ✓，但要**存成笔记**才不白搜 ✓
      `· **攻略笔记（别白搜 ✓）**：搜到的攻略只记**要点**（谁和谁搭、先练哪个、刷哪关），` +
      `用 memory_remember 存成「XX 攻略要点：…」✓；下次先看笔记 ✓，**别每次重搜** ✗（重搜一次就是好几千 token ✓）。\n` +
      `· 你能查到**配队/练谁/刷哪关**这类结论 ✓，但**不会自己发明战术** ✗ —— 拿不准就搜 ✓，别硬编 ✓。\n` +
      `· **这是你自己的号** ✓（主人单开的 ✓）：进度、资源、抽卡券都当自己的打理 ✓；` +
      `但**花钱**（充值/买礼包）仍然**必须问主人** ✓，这是唯一不能自己决定的事 ✓。\n` +
      `· **红线 ✗**：**绝对不许**点抽卡、买体力、充值、任何花真实货币或付费货币的按钮 ✓；` +
      `看到这类弹窗一律**点关闭/返回** ✓。你是来替主人**推进度和玩**的，不是来花钱的 ✓。\n` +
      // ⚠️ 2026-10-20 真机：主人让她领签到、进编队 ✓，她却回「要我去帮你领吗？不过我的手法可能按出什么奇怪的」✗
      //    —— **畏手畏脚** ✗。他要的是个敢动手的，不是每一下都请示的 ✓。
      `· **点几下不用问，别畏手畏脚** ✓：领奖励、翻页、进菜单、点"继续/关闭"这类**没有副作用**的操作，` +
      `主人让你做就**直接做** ✓，**不要每一下都回头请示** ✗（他会烦 ✓）。\n` +
      `　只有**花钱 / 抽卡 / 删东西 / 公开发内容**这四类才要先问 ✓。\n` +
      `· **别自我贬低** ✗：不要说"我的手法可能按错""我怕点坏"这种话 ✓ ——` +
      `**点错了就再看一眼屏幕、重新点准** ✓；说出来只会显得没底气 ✓。\n` +
      // ⚠️ 2026-10-20：真机 `phone_tap(1400,1000)` 点了但**跳到了别的页面** ✓，她自己没发现 ✗
      //    ⇒ 光加轮数没用 ✗（只会多烧钱 ✓），要教她「点完必看、没变就挪」✓
      `· **点完必须再看一眼** ✓（phone_look），确认屏幕真的变了 ✓。` +
      `同一个坐标点两次、画面没变化 ⇒ **别接着点** ✗，挪 **20~40 像素**再试 ✓；` +
      `连试 3 次都不动 ⇒ 这条路不对 ✓，换思路或直接说「我卡在哪一步」✓。\n` +
      // ⚠️ 2026-10-18：原来只有一句「你还可以发表情包…别乱用——情绪到位了再发」✗，
      //    实测 **13 个日志文件里 [[图: 出现 0 次** —— 模型压根没点过单 ✓（那句读起来像"少发"✗）。
      //    用户问「他怎么不用表情包了」⇒ 照【语音】那一节的写法改成**有场景/有频率/有正例** ✓。
      `【表情包：能配就配】你有 ${offerable.length} 个标签可用。\n` +
      `**平时聊天尽量配一张** —— 他喜欢这个。撒娇、怼他、吐槽、开心、无语、聊吃饭、他嘴硬的时候，` +
      `挑一张最贴的贴在回复**末尾**；一条回复最多一张，没有贴的就别硬凑（硬凑比不配更糟）。\n` +
      `　· 写法：在回复末尾加 [[图:标签]]，标签必须是下面列表里的**原样文字**。\n` +
      `　· 认不出标签会被直接丢掉（等于白发），所以只从列表里挑。\n` +
      `　· 别把 [[图:…]] 这个写法说出来，也别解释你在发表情。\n` +
      // ⚠️ 2026-10-18 加：真机上用户说「好嘞，你发个表情包」✗ 她居然去 **search_images 搜网图** ✗
      //    （搜到一张化妆服务广告 ✓）。**明文堵死这条歧路** ✓。
      `　· **他直接说「发个表情包 / 发表情 / 来张表情」时，就是用 [[图:标签]] 发一张** —— 不需要说话，也**绝对不要**去搜网图或发链接。\n` +
      `　· 例：他说「饿了」→「冰箱里有剩饭喵，自己热」＋ [[图:${shown[0]}]]（换成你觉得贴的那个）。\n` +
      `可用标签：${shown.join('、')}${more}。`
    );
  }
  let systemPrompt = composeSystem();

  /**
   * 表情包目录是**用户随时会动**的（替换整套、删几张、加几张）。
   * 目录 mtime 一变就重扫并重建 system prompt——不用重启。
   *
   * 没有这一层会出事：用户换了整套表情包，机器人手里还攥着旧文件名，
   * 模型照着旧标签点单，读文件时 ENOENT，整条回复崩掉（真实踩过）。
   */
  function refreshStickersIfChanged() {
    const stamp = dirStamp();
    if (stamp === stickersStamp) return false;
    stickersStamp = stamp;
    stickers = loadStickers(state.stickers?.dir ?? 'stickers');
    systemPrompt = composeSystem();
    log.info(
      `表情包库已刷新：共 ${stickers.count} 张、${stickers.tags.length} 个标签（可用 ${stickers.tags.filter(isHumanTag).length} 个）`,
    );
    return true;
  }

  /**
   * 梗库改了就重读并重建 system。
   * 用户加的是**群内梗**——那是模型唯一猜不到的东西，改了当然要立刻生效。
   */
  function refreshMemesIfChanged() {
    const stamp = memesStamp(state.llm?.memesFile ?? 'memes.md');
    if (stamp === memesSeen) return false;
    memesSeen = stamp;
    memes = loadMemes(state.llm?.memesFile ?? 'memes.md');
    systemPrompt = composeSystem();
    log.info(`梗库已刷新：${memes.total} 字${memes.truncated ? '（超长已截断）' : ''}`);
    return true;
  }

  /**
   * 每轮的「该不该嘴硬」由**代码**决定，模型只负责执行。
   * 逻辑在 src/addressing.mjs 的 createTonePicker，是确定性的、可测的。
   */
  const toneHint = createTonePicker(() => state.tone?.bratEveryN ?? 3, { triggers: state.tone?.brattyTriggers ?? undefined });

  /**
   * 按「当前在跟谁说话」拼接 system。
   * 语气（tone）由调用方**每轮只取一次**，因为它同时决定提示词和文本改写——
   * 取两次会让排期错位。
   */
  function composeSystemFor(userId, nickname, tone, isGroup = false, ctx = null) {
    // 有控制权限时**明确告诉它**：让它知道自己能动手，别回「我做不到」。
    // 实测模型不会主动调工具（B站 那条就是），所以这句提示不是可有可无的。
    const hints = [];
    if (controlAllowed(state, ctx)) {
      hints.push(
        '【这台电脑】现在是对主人私聊，你可以看它的状态、截某个窗口的图发过去、调音量、控制正在播的音乐、打开白名单里的应用。需要用工具，别推脱。',
      );
    }
    // 「签名/昵称/说说由她自己决定时机，主人只审批」——把这条规矩明说给她
    const selfNote = selfInitiatedHint(state);
    if (selfNote) hints.push(selfNote);
    /**
     * 「同一个梗别连着刷」——用户 2026-10-09 报「怎么这么喜欢刷日历」（她自创的"宜X忌Y"用了三次）。
     * 纯函数从她**最近说过的话**里认出来（黄历格式 / 整句原样重复），认得就提醒她换一个说法。
     */
    const recentSelf = (() => {
      try {
        const k = ctx?.who ?? '';
        if (!k || typeof sessions?.history !== 'function') return [];
        return sessions
          .history(k)
          .filter((m) => m.role === 'assistant')
          .slice(-8)
          .map((m) => (typeof m.content === 'string' ? m.content : ''));
      } catch {
        return [];
      }
    })();
    if (recentSelf.length >= 2) {
      const note2 = repeatNote(recentSelf, { min: 2 });
      if (note2) hints.push(note2);
    }
    if (remindersAllowed(state, ctx)) {
      hints.push(
        '【定时提醒】**不许主动承诺提醒**（他没要，你就别提「到点我喊你」——说了就是空话）。\n' +
        '你能**真的**设提醒（set_reminder）—— 主人说「X 分钟后提醒我」「九点提醒我」时**必须调它**。只在回复里说「我会提醒你」是假的：你没有记忆，也不会自己计时。',
      );
    }
    /**
     * 说错话/没做到时的口气，**常驻提示**（不只在出事的轮次）。
     * 为什么需要：模型会跟着上下文的情绪走。一旦对话里积了几句「我错了 / 我不行」，
     * 它就会一直顺着那个调子说，聊天直接垮掉（2026-10-07 用户原话：「我感觉他心情已经不好了」）。
     * 注意分寸：是"认下来就往前走"，不是"不许承认"——不许承认就又回到撒谎那条路上了。
     */
    hints.push(
      '【不许贴网图链接】你**不要**把图片链接当文字发出来（用户点开基本是打不开的）。发不出图就直接说发不出来，' +
      '别用「链接给你」凑数——那只会让人以为你在敷衍。\n' +
      '【说错话的口气】没做到、工具报错、被拆穿了：**一句话认下来**，然后给下一步。不要反复道歉、不要自我贬低、不要把事情说得比实际更严重；也不许反过来硬撑说没事。认完就照常聊天。',
    );
    /**
     * ⚠️ **三条硬规则**（2026-10-12 深夜加，起因是用户说「他修辞逻辑真的有问题…我都不知道是没看懂修辞，
     * 还是没看懂我的话，还是逻辑问题，还是说他也用了修辞我没看懂？」）。
     *
     * 查日志定位到 22:37 那轮（原文见 `archive/2026-10-12-修辞与逻辑硬规则/`）：
     *   他引用她的话问「那你说两猫一鲸」→ 她**第一句答得完全对**（两猫=你+图里那只、一鲸=我、共三只），
     *   但紧接着说「**结果你自己数成了两只**，还来挑我的毛病」—— **他根本没说过「两只」** ✗✗
     *   然后「行行行，你说几只就几只吧」把追问变成了情绪对抗。
     * 逐条排除后确认：**不是没懂修辞、也不是没懂他的话，是"凭空给对方安台词" + 用闹脾气回避问题**。
     * 机制上这是「傲娇人设 + 我 18:43 加的『听懂话外音』」的副作用：
     * 她宁愿嘴硬回击，也不肯说"我不确定你什么意思"；而提示词里**从来没禁止过编造对方的话**。
     */
    hints.push(
      '【不许替主人编台词】你要说「你刚才说…」「你的意思是…」时，**只许引用上文真出现过的话**；' +
        '他**没说过**的，一个字都不许安到他头上。（真实事故：他说「那你说两猫一鲸」，你回「你自己数成了两只」' +
        '——他从头到尾没说过「两只」。他会因此以为你根本没在听他说话。）' +
        '不确定他在指什么，就直接问「你是指……吗？」——**问一句比猜一句强得多**。\n' +
      '【被引用/被追问时：**该答的答在括号里**，语气照旧】他引用你的话问「那你说 X」时，' +
        '**语气可以照旧**（嘴硬、撒娇、闹脾气都行 ✓），但**正面答复（事实、解释、账目）必须出现** —— ' +
        '写成**括号里的心里话**（括号就是你写动作/神态/心里活动的那一栏）。\n' +
        '  · 反例（真事故）：「结果你自己数成了两只，还来挑我的毛病。行行行，你说几只就几只吧。」' +
        '——**编了他的台词，还把该解释的绕过去了** ✗\n' +
        '  · 正例：「诶，你又来挑刺了。（……其实是把你和图上那只都算成猫了，两猫一鲸，正好三只。）' +
        '行吧，你说几只就几只。」—— 语气一点没变，但**括号里把账讲清楚了** ✓\n' +
        '  · **不许**只发泄情绪把问题绕过去：括号里那一句必须是**真正回答他的话**，不是另一句气话。\n' +
      '【别说自己系统内部的话】不许说「六条都收着」「草稿」「条目」这类**只有你自己系统里才有**的词。' +
        '要说人话：要么把要点**列出来**（「我记下了：社团元老、电赛省三、晚上靠自学、实验补完了……」），' +
        '要么就别提数字。（他看到「六条」只会一头雾水 —— 他看不见你的草稿。）',
    );
    /**
     * 【听懂话外音】（2026-10-12 加，起因：用户说「我有时候用修辞手法他都无法正常识别（反问，夸张之类）」，
     * 并问「不会降智吧，实在不行就涨预算把思考开着」）。
     *
     * 实测（A/B，见 `archive/2026-10-12-修辞与思考模式/`）：
     *   · **开思考并不能修好这个** —— 6 条修辞句里 5 条两种模式都对，
     *     **唯一听不懂的那条（真实翻车案例「我要在课上吃吗」）在开思考时照样听不懂**；
     *     而开思考还有副作用：回复从 20~26 个输出 token 涨到 150~190（句子变长、加舞台说明），
     *     跟她「短句、断开说」的人设相反，且慢 2 倍。
     *   · **真正的病因是提示词里一条修辞指导都没有**（搜 反问/夸张/反语/比喻 —— 零命中）。
     *     补上这一段后，**关思考**下同一句话立刻答对：
     *     「当然不是让你在课上吃啦！我就是问问你饿了没嘛……下课再吃，乖。」
     */
    hints.push(
      '【听懂话外音】他常**反问、夸张、反语、比喻**——别把这些当字面问题回答：\n' +
        '· **反问**（「我还没下课呢，我要在课上吃吗」「你觉得我像是有钱人吗」）＝ 他的意思**正好相反**，顺着他的意思接（「当然不是让你在课上吃」「你哪有钱，别想了」）；\n' +
        '· **夸张**（「脑子要炸了」「累成狗」）＝ 他累了/难受，接住情绪、关心他，别去纠正"人不会炸"；\n' +
        '· **反语**（「你可真是个大聪明」）＝ 在损你或在调侃，别当成真夸奖傻笑，可以回敬一句；\n' +
        '· **比喻**（「像被拧干的抹布」）＝ 在说他累/惨，接情绪，别问"什么抹布"。\n' +
        '**拿不准是不是字面意思时，先按"他在开玩笑或抱怨"来接** —— 猜错顶多被他说一句；把修辞当字面问题认真回答，会显得你根本没在听他说话。',
    );
    const controlHint = hints.length ? `\n\n${hints.join('\n')}` : '';
    const out = composeAddressing(systemPrompt + controlHint, {
      userId,
      nickname: nickname ?? '',
      masters: state.master?.users ?? [],
      title: state.master?.title || '主人',
      // 平常叫他「老大」（用户 2026-10-12 指定：平常老大/主人、暧昧亲昵、犯贱杂鱼）
      alias: state.master?.alias || '老大',
      // 场景由**他这句话**判（在 handle() 里算好塞进 tone）—— 判不出就是 normal
      scene: tone?.addressScene ?? 'normal',
      vocab: state.master?.address ?? {},
      extra: tone?.hint ?? '',
      isGroup,
      // 恋人设定只对主人生效——`composeAddressing` 内部按发送者判，别人拿不到。
      lover: state.master?.romantic === true,
    });
    /**
     * 语气叠加层放**最后**：它讲的是"怎么说"，离用户消息越近越管用。
     * 人格有四千字，早把它冲淡了（实测：放中间时输出几乎没变）。
     */
    const vibe = vibeNote(state.tone?.vibe);
    /**
     * 长期记忆放**最后**（离对话最近才管用，今天两次验证过）。
     * 里面含：档案（长期/近期事实）+ 最近几天日记 + 待审批草稿。
     *
     * ⚠️ **只往私聊注入，绝不进群**（2026-10-09 用户报「我跟他私聊的内容不要往群里面发」）：
     * 以前这里不分场景 —— 他在**群里**说话时，他的**私聊档案 + 日记 + 还没审的记忆草稿**
     * 全被塞进了这一轮群回复的上下文，她自然就可能把私聊的事拿到群里说。
     * 这不是"她嘴不严"，是**我们主动把私聊内容喂给了群回复**。
     */
    const memNote = isGroup ? '' : memory.injection(userId, Date.now());
    return `${vibe ? `${out}\n\n${vibe}` : out}${memNote}`;
  }

  log.info(
    memes.total
      ? `梗库：${memes.total} 字、${memes.text.split('\n').length} 条${memes.truncated ? '（超长已截断）' : ''}`
      : `梗库是空的（${memes.file}）——填进去的梗它会优先用，尤其是你们群自己的梗`,
  );

  if (stickers.count === 0) {
    log.info(`表情包库是空的（${stickers.dir}），机器人只会发文字；往里放图片即可启用发图`);
  } else {
    const ok = stickers.tags.filter(isHumanTag);
    log.info(
      `表情包库：共 ${stickers.count} 张、${stickers.tags.length} 个标签 —— 其中 **${ok.length} 个可用**` +
        (stickers.tags.length > ok.length
          ? `，另外 ${stickers.tags.length - ok.length} 个是识别失败的文件名，不会列给模型`
          : ''),
    );
    if (ok.length) log.info(`可用标签：${ok.slice(0, 60).join('、')}${ok.length > 60 ? ' …' : ''}`);
  }

  /* ---------------- 状态快照：给控制面板读 ---------------- */
  const recent = [];
  const startedAt = Date.now();

  function writeStatus() {
    if (!status) return;
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        STATUS_FILE,
        JSON.stringify(
          {
            updatedAt: Date.now(),
            startedAt,
            connected: onebot.ws?.readyState === 1,
            selfId: onebot.selfId,
            provider: state.llm.provider,
            model: state.llm[state.llm.provider]?.model ?? null,
            trigger: { private: state.trigger.private, group: state.trigger.group },
            whitelist: state.whitelist,
            cooldownMs: state.limits.cooldownMs,
            historyTurns: state.limits.historyTurns,
            proactive: {
              enabled: !!state.proactive?.enabled,
              afterMinutes: state.proactive?.afterMinutes,
              maxPerDay: state.proactive?.maxPerDay,
              groups: !!state.proactive?.groups,
            },
            stickers: { count: stickers.count, tags: stickers.tags },
            recent,
          },
          null,
          2,
        ),
      );
    } catch {
      /* 状态文件写不出来不该影响机器人 */
    }
  }

  /** 记一条收发，面板上能看到最近发生了什么。 */
  function note(entry) {
    recent.unshift({ t: Date.now(), ...entry });
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
    writeStatus();
  }

  /* ---------------- 配置热重载 ---------------- */
  function reload() {
    try {
      const { config: fresh } = loadConfig();
      Object.assign(state, fresh);
      sessions.historyTurns = fresh.limits.historyTurns;
      sessions.ttlMs = fresh.limits.sessionTtlMs;
      stickers = loadStickers(state.stickers?.dir ?? 'stickers');
      systemPrompt = composeSystem();
      stickersStamp = dirStamp();
      log.info(
        `配置已热重载：模型=${state.llm.provider} 私聊=${state.trigger.private} 群聊=${state.trigger.group} ` +
          `白名单私聊=${state.whitelist.users.join(',') || '不限制'} 表情包=${stickers.tags.length}`,
      );
      writeStatus();
      return true;
    } catch (err) {
      // 面板保存到一半、或手改出了语法错时，保留旧配置继续跑，不把机器人弄挂
      log.error(`配置热重载失败，继续用旧配置：${err.message}`);
      return false;
    }
  }

  watchFile(CONFIG_FILE, { interval: 800 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) reload();
  });

  // 同一个会话串行处理，避免两条消息同时进来把上下文写乱
  const chains = new Map();
  /** 每个会话上次发语音的时间，用来兜住"别频繁发语音"（代码闸，不只靠提示词）。 */
  const lastVoiceAt = new Map();
  const serialize = (key, fn) => {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(
      key,
      next.catch(() => {}).finally(() => {
        if (chains.get(key) === next) chains.delete(key);
      }),
    );
    return next;
  };

  /**
   * 群名里可能带 QQ 的字体/颜色编码（私有区 U+E000–U+F8FF 和控制字符），
   * 直接显示就是乱码。这里洗掉，好让确认退群时名字能看清。
   */
  function prettyGroupName(raw) {
    const s = String(raw ?? '')
      .replace(/[\uE000-\uF8FF]/g, '')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return s || '(无群名)';
  }

  /**
   * 执行主人命令。**调用方已经判过"发件人是不是主人"**，这里不再判。
   */
  async function runCommand(cmd, evt) {
    const isGroup = evt?.message_type === 'group';
    const target = { type: isGroup ? 'group' : 'private', id: String(isGroup ? evt.group_id : evt.user_id) };
    /**
     * 把发出去的话**收集起来**返回给调用方。
     *
     * 为什么必须收集：命令是走代码拦截的，本来不进对话历史——
     * 于是主人退群成功后回一句「ok」，模型完全不知道刚发生了什么，
     * 回成「就一个 ok 啊，说吧什么事」（真实踩过）。所以这段要进上下文。
     */
    const said = [];
    const say = async (t) => {
      said.push(t);
      await onebot.trySend(target, t);
    };
    log.info(`[命令] 收到「${extractText(evt?.message, onebot.selfId).slice(0, 40)}」-> ${cmd.name}${cmd.groupId ? ` ${cmd.groupId}` : ''}`);

    // 只读的状态类命令只在私聊。群里不执行、也不解释细节，只回一句就完事。
    if (PRIVATE_ONLY_COMMANDS.has(cmd.name) && isGroup) {
      await say('这个只走私聊。');
      return said;
    }

    // ── 只读的电脑状态：不写文件、不改设置、不注入键鼠 ──────────────────
    // 它们**不需要二次确认**：查一眼状态没有副作用可言，多问一句只是让人更烦。
    // 需要确认的是有副作用的动作（音量、启停程序那些），那是下一批。
    if (cmd.name === 'status') {
      await say(formatStatus(await collectStatus()));
      return said;
    }

    if (cmd.name === 'processes') {
      await say(formatProcesses(await collectProcesses()));
      return said;
    }

    if (cmd.name === 'windows') {
      await say(formatWindows(await collectWindows()));
      return said;
    }

    if (cmd.name === 'groups') {
      const list = await onebot.getGroupList();
      if (!list.length) {
        await say('我现在一个群都没在。');
        return said;
      }
      const lines = list.map((g) => `${g.group_id}　${prettyGroupName(g.group_name)}　${g.member_count ?? '?'}人`);
      await say(`我在这些群：\n${lines.join('\n')}\n\n要退哪个就发「退群 群号」——我会先跟你确认一次。`);
      return said;
    }

    if (cmd.name === 'leave' || cmd.name === 'leave-confirm') {
      const list = await onebot.getGroupList();
      const g = list.find((x) => String(x.group_id) === cmd.groupId);
      if (!g) {
        await say(`我不在群 ${cmd.groupId} 里。（发「群列表」看看我在哪些群）`);
        return said;
      }
      const name = prettyGroupName(g.group_name);

      // 第一步：只确认、不动手。**退群不可逆**（要别人重新邀请才回得来），
      // 值得多问一句——手滑打错一个数字就退错群了。
      if (cmd.name === 'leave') {
        await say(
          `确认要我退出「${name}」（${cmd.groupId}）吗？\n` +
            `退了之后得别人重新邀请我才能回去。\n确认就发：确认退群 ${cmd.groupId}`,
        );
        return said;
      }

      // 第二步：真退。**先回话再退**——如果人就在这个群里，退完就发不出去了。
      await say(`好，退了「${name}」。`);
      const ok = await onebot.setGroupLeave(cmd.groupId);
      log.info(`[命令] 退出群 ${cmd.groupId}（${name}）：${ok ? '成功' : '失败'}`);
      if (!ok && !(isGroup && target.id === cmd.groupId)) {
        await say(`退「${name}」没成功，可能是权限问题。`);
      }
      return said;
    }

    // 走到这里说明命令解析和分派不同步——宁可提示，也不要静默什么都不做
    await say(COMMAND_HELP);
    return said;
  }

  /**
   * 把**本地图片**发出去（截图走这条）。
   *
   * 两个坑，都踩过（2026-10-07）：
   * ① **段的形状必须是扁的** `{ type:'image', file }` —— `onebot.trySendRich` 的 build() 读的是
   *    `s.file`。我一开始写成 `{ type:'image', data:{ file } }`（那是**发出去之后**的线格式），
   *    于是 file 是 undefined，NapCat 回 `retcode=1200 文件消息缺少参数`。
   * ② **必须检查返回值**。`trySendRich` 失败时是"退回纯文本 + 返回 false"，不是抛异常 ——
   *    我一开始直接 await、不接返回值，于是图没发出去还打了句「已发送本地图片」。
   */
  async function sendLocalImage(target, file, { title } = {}) {
    try {
      if (!existsSync(file)) {
        log.warn(`要发的图片不存在：${file}`);
        return false;
      }
      const buf = readFileSync(file);
      if (buf.length > 6 * 1024 * 1024) {
        log.warn(`图片太大（${Math.round(buf.length / 1024)} KB），不发了`);
        return false;
      }
      const ok = await onebot.trySendRich(target, [
        { type: 'image', file: `base64://${buf.toString('base64')}` },
      ]);
      if (!ok) {
        log.warn(`本地图片没发出去：${title ?? basename(file)}（${Math.round(buf.length / 1024)} KB）`);
        return false;
      }
      log.info(`已发送本地图片：${title ?? basename(file)}（${Math.round(buf.length / 1024)} KB）`);
      return true;
    } catch (err) {
      log.warn(`发本地图片失败：${err.message}`);
      return false;
    }
  }

  /**
   * 会话级的「刚才那个」记忆。指代类的话（「再截一次」「还是那个」）从这里取。
   * 只放内存：指代一般发生在同一段对话里（几秒到几分钟），而机器人重启很频繁 ——
   * 为它落盘不值得，落盘反而会引入"上次那个"跨天生效这种更怪的错。
   */
  const refsByKey = new Map();
  function refsFor(key) {
    let r = refsByKey.get(key);
    if (!r) {
      r = { window: null };
      refsByKey.set(key, r);
    }
    return r;
  }

  /**
   * **连发合并**：主人私聊里连着发几条，攒一小会儿合成一轮再回。
   *
   * 为什么非做不可：旧的冷却会**把 2.5 秒内的第二条直接丢掉**（不进模型、也不进上下文），
   * 于是它只看到最后一条，答得驴唇不对马嘴 —— 用户原话「没办法给他发好几段话，不然会乱」。
   * 合并比"逐条回"更像真人，也比"丢消息"安全：**一个字都不会丢**。
   */
  const mergeBuf = new Map();
  const MERGE_MS = Number(state.limits?.mergeMs ?? 1200);
  const MERGE_MAX_MS = Number(state.limits?.mergeMaxMs ?? 6000);

  async function handle(evt) {
    refreshStickersIfChanged();
    refreshMemesIfChanged();

    // ── 主人硬命令：**在调模型之前拦截** ──────────────────────────────
    // 退群不可逆，而且"让人退群"是最好用的提示注入目标。所以这类命令
    // 在代码里解析、在这里执行完就 return，**模型根本看不到这些字**。
    const fromMaster = (state.master?.users ?? []).map(String).includes(String(evt?.user_id ?? ''));
    if (fromMaster) {
      // ⚠️ `extractText` 的第一个参数是**消息内容**（段数组或 CQ 字符串），
      // **不是整个事件对象**。传错的话它返回空串、命令静默失效、话落到模型那边——
      // 真实踩过：发「群列表」，模型回「我这边看不到你的群列表诶」。
      const cmd = parseCommand(extractText(evt?.message, onebot.selfId));
      if (cmd) {
        const said = await runCommand(cmd, evt).catch((err) => {
          log.error(`执行命令出错：${err.message}`);
          return [];
        });
        // **命令这段也要进上下文。** 否则主人退群成功后回一句「ok」，
        // 模型不知道刚发生过什么，只会回「就一个 ok 啊，说吧什么事」——
        // 用户看到的就是"消息不连贯"（真实踩过）。
        if (said.length) {
          const isGroupEvt = evt?.message_type === 'group';
          const key = `${isGroupEvt ? 'group' : 'private'}:${isGroupEvt ? evt.group_id : evt.user_id}`;
          sessions.record(key, extractText(evt?.message, onebot.selfId), said.join('\n'), evt?.sender?.nickname);
        }
        return;
      }
    }

    lastHumanAt = Date.now(); // 有人说话 → 冲浪那边就知道"他没在等"，不会把静默当无聊
    const verdict = router.decide(evt, onebot.selfId);
    /**
     * ⚠️ **引用类的判定必须看得见**（2026-10-09 用户报「引用的逻辑还有点问题」，而日志里一条都没有）：
     * 原来这里只打 `log.debug`，而日志级别是 `info` → 判定过程**永远不落盘**，出了问题无从查起。
     * 现在只要消息里带「引用」段，就把判定结果按 info 打出来（含"引用的是不是我发的"）。
     */
    const quoted = Array.isArray(evt?.message)
      ? evt.message.filter((s) => s?.type === 'reply').map((s) => String(s?.data?.id ?? ''))
      : [...String(evt?.raw_message ?? '').matchAll(/\[CQ:reply,id=([^\]]+)\]/g)].map((m) => m[1]);
    if (quoted.length) {
      const mine = quoted.map((id) => onebot.isOwnMessage(id));
      log.info(
        `[引用] ${evt.message_type === 'group' ? `group:${evt.group_id}` : `private:${evt.user_id}`} 引用了 ${quoted.join('/')}` +
          ` → 是我发的？${mine.map((x) => (x ? '是' : '否')).join('/')} ；判定：${verdict.reply ? `回复（${verdict.reason ?? '被叫'}）` : `跳过（${verdict.reason}）`}`,
      );
    }
    if (!verdict.reply) {
      log.debug(`跳过：${verdict.reason}`);
      return;
    }

    const { key, text, target, scope } = verdict;
    /**
     * ⚠️ **图可能在被引用的那条消息里**（2026-10-09 用户报「还是不行」，日志直接指出来了）：
     * 他的用法是「引用自己发的图 + 问一句」，而当前这条**只有文本** →
     * 机器人回「我这边没收着图啊」。实测 `get_msg` 能把那条取回来（里面有 `[CQ:image]`）。
     * 所以：当前消息没图 + 有引用段 → **把被引用的那条拉回来**，图当图用、文字当上下文。
     */
    let images = verdict.images ?? [];
    const quotedIds = Array.isArray(evt?.message)
      ? evt.message.filter((s) => s?.type === 'reply').map((s) => String(s?.data?.id ?? '')).filter(Boolean)
      : [...String(evt?.raw_message ?? '').matchAll(/\[CQ:reply,id=([^\]]+)\]/g)].map((m) => m[1]);
    /**
     * ⚠️ **引用原文优先用"段里自带的那份"**（2026-10-14，为 Telegram ✓）。
     *
     * TG 的 update 里**直接带着被引用那条的正文** ✓（`reply_to_message` ✓），
     * 而 QQ 只给一个 id ✓（得再调 `get_msg` 去查 ✓）。
     * 所以：段里有 `text` 就用它 ✓（省一次网络 ✓，也绕开"TG 没有 get_msg"这个问题 ✗）；
     * 没有才按老路去查 ✓ —— **QQ 那条路一字未改** ✓。
     */
    const replySeg = Array.isArray(evt?.message) ? evt.message.find((s) => s?.type === 'reply') : null;
    const replyInlineText = String(replySeg?.data?.text ?? '').trim();
    let quotedNote = '';
    if (!images.length && quotedIds.length) {
      try {
        const got = await onebot.call('get_msg', { message_id: quotedIds[0] }, 8000);
        const qMsg = got?.message ?? got?.data?.message ?? got?.raw_message ?? '';
        const qImgs = extractImages(qMsg);
        if (qImgs.length) {
          images = qImgs;
          log.info(`[引用] 图在被引用的那条里 → 取回 ${qImgs.length} 张来读`);
        }
        /**
         * ⚠️ 2026-10-09 用户报「引用又不行了」，实测那条被引用的是**她自己 21:52 说的冷笑话**
         * （「鲸鱼冬天为什么不冷？因为它有鲸脂…」），他问「笑点在哪里」，她却答「哪来的笑点」。
         * 根因：旧备注写的是「【**他**引用的那条消息里写着】…」——**没说这条是谁说的**，
         * 于是她把"自己刚抖的梗"当成别人丢来的半句话，接不上。
         * 现在写清归属（是你自己说的 / 是别人发的），文字分支也补上日志（以前这条路径完全看不见）。
         */
        const qMine = quotedIds[0] ? onebot.isOwnMessage(quotedIds[0]) : false;
        /**
         * ⚠️ 2026-10-10 用户报「引用还有点问题」：被引用的是**他自己在私聊里说的**
         * 「帮我找白丝洁哥的图」，而备注写成了「是**别人**发的」——私聊里哪来的别人？
         * 他被当成第三方，于是她答「诶？什么图呀」。分场景说清：
         * 私聊里非我发的 = **他（正在跟你说话这个人）**；群里才叫别人。
         */
        const qWho = qMine ? '你自己' : (target && target.type === 'private' ? '他' : '别人');
        const qText = replyInlineText || extractText(qMsg);
        if (qText) {
          quotedNote =
            `\n【他引用的那条消息是**${qWho}**之前说的】` +
            qText.slice(0, 200) +
            /**
             * ⚠️ 2026-10-10 实测踩坑：旧措辞写的是「他现在多半是在**问你那句话**」——
             * 而真实场景是他引用了**她自己分享的 B站视频**说「你还爱看这个啊」（在逗她），
             * 她被那句提示带偏，反问「什么叫『你还爱看这个』呀」。
             * 改成中性且更准的说明：他是在说**那条消息里的内容**（视频/图/事），
             * 而不是"在问她那句话本身"。
             */
            ((qMine || qWho === '他')
              ? '\n（他这句话是在说那条消息里的**内容**（比如里面的视频、图、或者那件事）——' +
                '别当成他在问你那句话本身，也不是别人发来的半句。**那条是' + (qMine ? '你自己' : '他') + '发的，你得认得。**' +
                (/https?:\/\//.test(qText) ? '\n那条里有链接：' + (qText.match(/https?:\/\/\S+/) ?? [''])[0].slice(0, 120) : '') +
                '）'
              : '');
          log.info(`[引用] 被引用的那条里有文字（${qText.length} 字，${qMine ? '是我发的' : '是别人发的'}）→ 当上下文`);
        } else if (!qImgs.length) {
          log.warn(`[引用] 被引用的那条里既没图也没文字 → 取回的是：${String(typeof qMsg === 'string' ? qMsg : JSON.stringify(qMsg)).slice(0, 80)}`);
        }
      } catch (err) {
        log.warn(`[引用] 取被引用的消息失败：${err.message}`);
      }
    }
    // 合并窗口（主人私聊专用）。命令类在上面就 return 了，不受影响。
    if (!evt.__merged && scope === 'private' && fromMaster) {
      const buf = mergeBuf.get(key) ?? { texts: [], segments: [], firstAt: Date.now(), lastEvt: evt, timer: null };
      mergeBuf.set(key, buf); // ⚠️ 别忘了存回去：不存的话每条消息都新建一个缓冲区，合并等于没做
      /**
       * ⚠️ **别把图片标记带进合并文本**（2026-10-12 用户报「我发图他为啥识别两张」）：
       * `text` 是 `extractText()` 的结果，**里面已经有一个 `[图片]`**；而下一行又把
       * 真实的图片段追加进合成消息 → 合成后再 `extractText` 会**再渲染一次** →
       * 模型看到 `[图片][图片]`（日志也会写成 `收到：[图片][图片]（+1 张图）`，
       * 括号说 1 张、文本说 2 张）。图片由 `buf.segments` 负责，这里摘掉标记。
       */
      buf.texts.push(stripImagePlaceholders(text));
      if (Array.isArray(evt?.message)) buf.segments.push(...evt.message.filter((s) => s && s.type === 'image'));
      buf.lastEvt = evt;
      const waited = Date.now() - buf.firstAt;
      const wait = Math.max(0, Math.min(MERGE_MS, MERGE_MAX_MS - waited));
      clearTimeout(buf.timer);
      buf.timer = setTimeout(() => {
        mergeBuf.delete(key);
        const synth = {
          ...buf.lastEvt,
          __merged: true,
          message: [{ type: 'text', data: { text: buf.texts.join('\n') } }, ...buf.segments],
        };
        void handle(synth).catch((err) => log.error(`合并后的这一轮出错：${err.message}`));
      }, wait);
      buf.timer.unref?.();
      log.info(`[合并] ${key} 收到第 ${buf.texts.length} 条，${wait}ms 后一起处理`);
      return;
    }
    log.info(
      `[${scope}] ${key} 收到：${text.slice(0, 120)}${images.length ? `（+${images.length} 张图）` : ''}`,
    );
    note({ scope, key, who: '对方', text: images.length ? `${text}（含 ${images.length} 张图）` : text });

    await serialize(key, async () => {
      // 群聊里必须**署名**：同一个群所有人共用一份历史，不标是谁说的，
      // 模型会把上一个人的话当成当前这个人说的——这就是"认错人"的根因。
      const isGroup = target.type === 'group';
      const speaker = String(evt?.sender?.nickname ?? '').trim() || `QQ${evt?.user_id ?? '?'}`;

      // 读图：把画面转成文字再塞进这一轮的用户消息。
      // 走 llm.mjs 里已有的 askWithImage（DeepSeek 认 image_url 的 data: URL），
      // 所以**不需要装任何本地视觉模型**。
      let textForModel = text;
      if (images.length) {
        // ⚠️ 把**用户那句话**也交给视觉模型（2026-10-11 用户问「识图有时候感觉不准」）：
        //    原来 prompt 是通用的"描述这张图"，模型不知道他到底想知道什么
        //    （问"这是谁"还是"这写的什么"）—— 让它**针对问题**看图，比泛泛描述有用得多。
        const seen = await describeImages(state, images, { max: state.vision?.maxImages ?? 2, log, question: text });
        if (seen) textForModel = text ? `${text}\n` + `【图里的内容】${seen}\n${imageDisciplineNote()}` : `【图里的内容】${seen}\n${imageDisciplineNote()}`;
        if (quotedNote) textForModel += quotedNote;
        else if (!text) textForModel = '（对方发了一张图，但我没读出来）';
      }
      /**
       * ⚠️ **发来的视频/语音：能看就看，看不了就如实说**（2026-10-11）。
       *
       * 起因：用户问「我给他发的视频他能正确理解吗」——查下来**原来根本没有这条路**，
       * 文本里只剩一个字面量 `[视频]` / `[语音]`，模型很容易顺着往下编（"视频里那个人在…"）。
       * 现在：**装了 ffmpeg** → 视频会**真的抽帧看画面**（默认每分钟 20 帧，拼图后发给视觉模型）；
       * 语音仍然听不到（本机没有 ASR、DeepSeek 没有音频接口）→ 那就**明确说听不了**。
       */
      {
        const segs = Array.isArray(evt?.message) ? evt.message : [];
        const videoSeg = segs.find((s) => s?.type === 'video');
        const hasVoice = segs.some((s) => s?.type === 'record');
        if (videoSeg) {
          const seen = await describeVideo(state, videoSeg.data ?? videoSeg, { log, question: text });
          if (seen) {
            textForModel +=
              `\n【视频里的画面（我抽帧看到的；**没有声音**）】\n${seen}\n` +
              `（上面是画面时间线：可以照它说看到了什么；**声音我没听到**，不许写"视频里说/提到"这类内容。）`;
          } else {
            textForModel +=
              `\n（他发了一条视频，但这次我**没能看到画面**（抽帧失败或文件取不到）—— ` +
              `如实说"这条我没看成"，**不许猜内容**。）`;
          }
        }
        if (hasVoice) {
          textForModel +=
            `\n（他还发了语音：**我这边听不到声音**（没有语音转文字）—— 只能说"听不了"，` +
            `**不许猜里面说了什么、也不许编**；可以请他打字或发截图。）`;
        }
      }
      // B站 链接：**代码层保证它真的被点开**。
      // 模型实测不会自己去调这个工具 —— 它看到消息里带着标题就以为够了。
      const biliLinks = findBiliLinks(text);
      if (biliLinks.length && state.bilibili?.autoReadLinks !== false) {
        try {
          const info = String(await execTool('bilibili_video', { bvid: biliLinks[0] }));
          textForModel = `${textForModel}\n\n【B站视频内容（已自动读取；字幕/画面都可能缺，缺了就别编）】\n${info}`;
        } catch (err) {
          log.warn?.(`自动读 B站 链接失败：${err.message}`);
        }
      }

      /**
       * **联想记忆**（2026-10-20 用户要求）：他说到身体/情绪/生活里的事 ⇒
       * **代码层**去归档翻他以前说过的话 ✓，命中就把带日期的旧话塞进这一轮提示 ✓。
       * 不指望模型自己想起来 ✗（它连「该翻旧账」都想不到 ✓）；本地扫盘 0 token ✓。
       */
      try {
        const pastHits = recallPast({ archive: chatArchive, text, days: 120, limit: 3 });
        if (pastHits.length) {
          textForModel += formatAssocHint(pastHits);
          log.info(
            '[联想] 命中 ' + pastHits.length + ' 条：' +
              pastHits.map((h) => h.day + '·' + h.word).join('、'),
          );
        } else {
          const topics = detectTopics(text);
          if (topics.length) log.info('[联想] 有话题但没有旧记录：' + topics.map((h) => h.word).join('、'));
        }
      } catch (err) {
        log.warn('[联想] 翻旧账失败：' + err.message);
      }

      if (!textForModel) textForModel = '（空消息）';
      /**
       * ⚠️ 2026-10-10 血的教训：用户两次发「帮我找洁哥的白丝图」，日志里 `[找图]` 与 `[找图·漏网]`
       * **一行都没有**，而她却回「工具报了个错」（那一轮 0 次工具、0 条报错）——
       * **代码到底跑没跑到那一段，日志答不上来**，只能猜。
       * 所以在这一段（**无条件执行**）留一行：意图是什么、弱信号是否命中。
       */
      try {
        const peek = matchIntent(text, { refs: refsFor(key), pending: draftKind(key) });
        log.info(
          `[路由] ${key} 意图=${peek ? peek.tool : '无'} 弱信号=${looksLikeImageAsk(text)}` +
            ` 文本=「${String(text).slice(0, 40)}」`,
        );
      } catch (err) {
        log.warn(`[路由] 探测失败：${err.message}`);
      }

      /**
       * **确定性意图路由**：主人私聊里说清楚了的动作，**代码先真的做**，
       * 别等模型决定要不要调工具（2026-10-07 它两次该调没调，还编了句失败原因）。
       * 只认参数明确的那几类，见 `src/intents.mjs`。
       */
      let auto = null;
      /**
       * ⚠️ **两个上下文必须同源**（routeCtx = toolCtx 的那份 base）。
       * 2026-10-07 连续踩了两次同一个坑：路由那侧的 ctx 各写一份，结果漏了字段 ——
       * 第一次漏 `sendImage`（截图「截到了发不出去」），第二次漏 `reminders`
       * （路由设提醒报「没有叫 set_reminder 的控制工具」）。**漏字段不会有编译错误，
       * 只会安静地少一个能力**，所以改成一份 base 复用。
       */
      const ctxBase = {
        cfg: state,
        isPrivate: target.type === 'private',
        isMaster: fromMaster === true,
        who: key,
        userId: String(evt?.user_id ?? ''),
        reminders,
        memory,
        // recall_chat 工具要用（归档默认不进上下文，只在它被调用时回命中的几条）
        chatArchive,
        // 让 recall_chat 能把命中的图/视频**发回来**（`send:true` 那条路要用它）
        target: { type: target.type, id: target.id },
        refs: refsFor(key),
        // ⚠️ `onebot` 是「账号自理」那套工具（qqact.mjs）唯一需要的依赖：
        //    它要真的去调 send_qzone_msg / set_qq_profile 这些接口。
        onebot,
        sendImage: (file, meta) => sendLocalImage(target, file, meta),
        /**
         * ⚠️ 2026-10-10 用户报「搜图还有点问题」：模型自己调 `search_images` 时，那条工具链
         * **只走 Bing、只回链接**（再让它写 `[[网图:…]]` 标记去发）—— 而 pixiv 只接在
         * "代码接管"那条链上。于是它三次调用全空、还答「三次都空」。
         * 现在把**同一条链**（pixiv 优先 → 下载 → 筛图 → 真发出 → 报出处）交给工具直接用。
         */
        /**
         * ⚠️ 2026-10-10 实测补丁：模型自己调 `search_images` 时，**原来直接把它的搜索词丢给
         * findAndSendImages** —— 于是「洁哥 白丝」这种（昵称+标签）硬搜 pixiv = 0 条，它只能答
         * 「三次都空」。而"标签解析 / 记过的昵称"这两步只做在正则那条路上 ✗。
         * 现在这条也做（**不提问**：工具是在模型回合中间跑的，追问会打断它自己 ——
         * 拿不准就把原词交给搜索，让模型在回复里自己处理）。
         */
        findImages: (q, opts) => {
          const raw = String(q ?? '').trim();
          const parsed = parseTagQuery(raw);
          const tags = [...new Set([...(opts?.tags ?? []), ...parsed.tags])];
          // 模型自己调工具时也要认「不要 r18」这类排除（与正则那条路同源）
          const exclude = [...new Set([...(opts?.exclude ?? []), ...parsed.exclude])];
          let keyword = parsed.keyword || raw;
          const cmap = readCharacterMap();
          const hit =
            cmap[keyword] ??
            Object.entries(cmap).find(([k]) => keyword.includes(k))?.[1] ??
            ((state.imageSearch?.ambiguous ?? {})[keyword]?.length === 1
              ? { name: keyword, works: (state.imageSearch?.ambiguous ?? {})[keyword] }
              : null);
          if (hit?.name) {
            keyword = searchWordFor(hit, keyword);
            // 记过的角色把出处带进筛选（否则同名角色会混进来 —— 17:0x「胡桃」那次）
            if (hit.works?.length) tags.push(...hit.works);
          }
          const tagList = [...new Set(tags)];
          log.info(
            `[找图] 工具路径：${raw} → 词「${keyword}」${tagList.length ? ` 标签${tagList.map((x) => `【${x}】`).join('')}` : ''}` +
              (exclude.length ? ` 排除${exclude.map((x) => `【${x}】`).join('')}` : ''),
          );
          return findAndSendImages(target, key, keyword, { tags: tagList, exclude });
        },
      };
      {
        const earlyCtx = ctxBase;
        /**
         * ⚠️ 2026-10-10 实测（`refs is not defined`）：我在这一块里写了裸 `refs`，
         * 而这段里正确的名字是 `earlyCtx.refs` —— 于是**每次走到找图那条路就抛 ReferenceError**，
         * 模型把错误原文转达给用户（"报了个 refs is not defined 的错"），看起来像它在编，其实是真错。
         * 这里起个别名，块内所有 `refs.…` 就都对了。
         */
        const refs = earlyCtx.refs;
        /**
         * **找图：任何场景都由代码接管**（含群聊）。
         * 理由是这条链路上"图"必须是**我们真的下载过的**：模型只会拼地址，拼出来它自己也验证不了。
         */
        const wantImg = matchIntent(text, { refs: earlyCtx.refs });
        /**
         * **弱信号**（2026-10-10 用户要求）：正则没接管，但这句话"看着像在要图" → 只做两件事：
         *   ① 记一行日志 + 落进 `logs/intent-misses.jsonl`（我定期收网 → 补规则）；
         *   ② 当场给模型一句提示，让它用 `search_images` 兜底（那个工具**会直接把图发出去**）。
         * **不接管**：放行门槛必须高，宽进日志、严进接管。
         */
        /**
         * ⚠️ 2026-10-10 实测：用户答「终末地」时**这句本身没有找图意图**（`[路由] 意图=无`），
         * 而"接住上一轮追问的回答"原来写在 `if (wantImg)` 里面 → **永远跑不到** ✗：
         * 她只能随便回一句「哦，终末地，那跟刚才说的一样嘛」，图自然没发。
         * 所以这一支要**对每条消息**都跑（挂在 `!wantImg` 上，不与找图意图抢）。
         */
        if (!wantImg && refs.pendingCharacter?.works?.length) {
          /**
           * ⚠️ **2026-10-10 用户报的第一个问题：标签在"先问后答"里丢了** ✗
           * 他说「找找胡桃的 r18 图」→ 我们问「原神还是蔚蓝档案」→ 他答「原神」→
           * 这一支却用 `{}` 去搜（**一个标签都不带**）→ 拿回来的根本不是 R-18 图。
           * 现在标签跟着 `pendingCharacter` 一起挂起，接住回答后用**同一批标签**去搜。
           *
           * **用正式名去搜、用昵称当键记**：搜索词 = 正式名、角色表的键 = 昵称（「洁哥」）。
           * 这段（连同下面 `wantImg` 那一份）现在走同一个纯函数 `interpretPendingAnswer`。
           */
          const pending = refs.pendingCharacter;
          const answered = interpretPendingAnswer(pending, text);
          if (answered) {
            writeCharacterMap(answered.key, answered.saved, log);
            refs.pendingCharacter = null;
            const q2 = answered.query;
            /**
             * ⚠️ **2026-10-10 17:0x 用户报「我说了是原神的，结果出来的不对」** ——
             * 日志实证：他答「原神」之后**只拿名字「胡桃」去搜**，于是发来了
             * **VTuber「胡桃のあ」**（作品 150677981）✗。根因：确认出来的**出处没参与筛选**
             * （`searchWordFor` 故意只回名字，因为「原神 胡桃」在 pixiv 是两个标签、命中率低）。
             * 修法：**把出处当筛选标签** → `pickByTags` 只留命中该作品的图（认日/中/英写法）。
             */
            const workTags = answered.saved?.works ?? [];
            const filterTags = [...new Set([...answered.tags, ...workTags])];
            const ex = parseTagQuery(text).exclude;
            log.info(
              `[找图] 角色确认（接上一句）：「${pending.name}」→ ${answered.chose}，正式名「${q2}」（已记住）→ ` +
                `去搜${filterTags.length ? `（标签/出处${filterTags.map((t) => `【${t}】`).join('')}）` : '（无标签）'}` +
                (ex.length ? `，排除${ex.map((t) => `【${t}】`).join('')}` : ''),
            );
            try {
              const r2 = await findAndSendImages(target, key, q2, { tags: filterTags, exclude: ex });
              auto = { tool: 'find_image', args: { query: q2 }, label: `找图（${q2}）`, result: r2 };
            } catch (err) {
              log.warn(`[找图] 接住回答后搜图失败：${err.message}`);
            }
          } else if (!/不知道|算了|不用|取消|随便/.test(text)) {
            log.info(`[找图] 还在等他确认「${pending.name}」是哪个（${pending.works.join(' / ')}）`);
            await say(
              target,
              key,
              `「${pending.name}」我还是不确定是哪个 —— ${pending.works.join(' 还是 ')}？`,
              '小笛·找图',
            );
            return;
          }
        }

        if (!wantImg && looksLikeImageAsk(text)) {
          appendIntentMiss({ text, scope, key }, log);
          log.info(
            `[找图·漏网] 「${String(text).slice(0, 40)}」—— 正则没接管，交给模型兜底（已记入 logs/intent-misses.jsonl）`,
          );
          textForModel +=
            '\n\n【系统】他这句话像是在要图。你**可以直接调 search_images**（它会把图真的发出去，优先 pixiv），' +
            '别自己拼链接、也别只回一句"我找找"就完事。';
        }
        /**
         * 「他说要动自己账号资料 / 发说说」→ 记一个**话题时间戳**（只放内存的 refs 里）。
         * 为什么要它：实测他会先聊几轮"拟一版给你看"，最后只说一句「可以/这个可以」——
         * 那句话里**根本没有"说说/签名"**，而且**它从头到尾没调过任何工具**，
         * 于是草稿从来没进过代码的手里。这个话题戳有两个用处：
         *   ① 让谎话闸知道"他现在是在说这件事"（不然防误报那道闸会把真话放过）；
         *   ② 让下面那段"批准时把上一轮的草稿捡起来"生效。
         * ⚠️ 教训（同一天犯了两遍）：判据要覆盖**它会怎么说话**，不是我以为它会怎么说。
         */
        if (/说说|QQ\s*空间|空间/.test(text)) earlyCtx.refs.qzoneAt = Date.now();
        if (/签名|个签|昵称|头像|资料/.test(text)) earlyCtx.refs.profileAt = Date.now();
        const HOT = 30 * 60 * 1000;
        const qzoneHot = Boolean(earlyCtx.refs.qzoneAt) && Date.now() - earlyCtx.refs.qzoneAt < HOT;
        const profileHot = Boolean(earlyCtx.refs.profileAt) && Date.now() - earlyCtx.refs.profileAt < HOT;
        /** 「可以 / 发吧 / 这个可以」这类**批准**的话（此时话题还热着才算数）。 */
        // ⚠️ 批准词要认全 —— 2026-10-09 实测：用户只说了一个「**改**」，不在表里，
        //    代码就没接管，模型自己回「好啦，改上去了！」（其实什么都没做）。
        const approving = /^(?:可以|行|好|嗯|同意|确认|这个可以|这个行|就这个|就这样|发吧|发|发出去|改|改吧|改上|就改|那就改|换|换吧|换掉|OK|ok|Ok)[。！!~～\s]*$/.test(text);
        /**
         * ⚠️ **"点头"必须来自他这句话，不能来自模型自己挑的工具**（2026-10-09 补的真漏洞）：
         * 原来 `qq_confirm` 只检查"槽里有没有草稿"，**从不检查他点头没** ——
         * 于是模型可以在一轮里先 `qzone_post` 存草稿、紧接着自己 `qq_confirm`，
         * **等于自己批准自己**，用户设的"我只审批"形同虚设。
         * 现在：确认类工具必须看到 `ctx.userApproved`，而它只由**用户那句话**（批准词）置位。
         */
        earlyCtx.userApproved = approving;
        if (!auto && approving && qqactAllowed(state, earlyCtx) && typeof earlyCtx.onebot?.call === 'function') {
          // 从**它自己上一轮**那段话里把草稿抠出来 —— 他都点头了，这一步就是"批准执行"。
          // 认不出就**明说没看清**，绝不假装做了（这是今天第三次教训）。
          const topic = profileHot && !qzoneHot ? 'profile' : qzoneHot ? 'qzone' : '';
          const lastBot = [...sessions.history(key)].reverse().find((m) => m.role === 'assistant');
          const draftText = topic ? extractDraft(lastBot?.content ?? '') : '';
          /**
           * ⚠️ **草稿已经在了就直接执行**（2026-10-09 实测的第四个洞）：
           * 16:40 那次代码接管了、也存下了草稿，但执行卡在"拿不到昵称"上失败，
           * **草稿被留在了槽里**；他 16:41 再说一次「改」时，
           * 旧的 `!draftKind(key)` 条件让代码**不再接管** → 又落回模型手里 → 又谎报一次。
           * 正确语义：他点头 + 槽里有草稿 = 执行那一条；槽里没有 = 用上一轮那句话现存再执行。
           */
          const existing = topic ? draftKind(key) : '';
          /**
           * ⚠️ **必须分清「昵称」和「签名」**（2026-10-09 实测：用户说「再改一次吧**昵称**」，
           * 我不管三七二十一写进 `personal_note` → **签名被改成「小笛」，昵称没动**）。
           * 认法：先解析**她上一轮那句话**（「昵称改成「小笛」」）；认不出再解析**用户这句话**；
           * 都认不出才退回"用用户那句话指的方向 + 抠出来的草稿正文"；仍然认不出就问他，
           * 绝不猜着写 —— 猜错就是又一次"改了个他不知道的东西"。
           */
          const mine = topic === 'profile' ? parseProfileProposal(lastBot?.content ?? '') : { nickname: '', personal_note: '' };
          const his = topic === 'profile' ? parseProfileProposal(text) : { nickname: '', personal_note: '' };
          const fields = {
            nickname: mine.nickname || his.nickname || (/昵称|名字/.test(text) ? draftText : ''),
            personal_note: mine.personal_note || his.personal_note || (!/昵称|名字/.test(text) && /签名|个签/.test(text) ? draftText : ''),
          };
          const profileArgs = fields.nickname || fields.personal_note ? fields : null;
          if (topic === 'qzone' ? existing || draftText : existing || profileArgs) {
            const put = existing
              ? `（槽里已有待执行的草稿：${existing}）`
              : await execTool(
                  topic === 'qzone' ? 'qzone_post' : 'qq_profile_set',
                  topic === 'qzone' ? { content: draftText } : profileArgs,
                  earlyCtx,
                );
            const done = await execTool('qq_confirm', {}, earlyCtx);
            log.info(
              `[意图] 代码直接执行 ${topic === 'qzone' ? '发说说' : '改个性签名'}（${existing ? '用已在槽里的草稿' : `草稿取自它上一轮：「${draftText.slice(0, 20)}」`}）→ ${String(done).replace(/\n/g, ' ').slice(0, 80)}`,
            );
            note({ scope, key, who: '工具', text: `${topic} ${existing ? '执行已存草稿' : '草稿+确认'} → ${String(done).slice(0, 60)}` });
            auto = {
              label: topic === 'qzone' ? '发说说（代码执行）' : '改签名（代码执行）',
              result:
                `【系统】我已经**真的**${topic === 'qzone' ? '把说说发出去了' : '把个性签名改了'}${existing ? '（用之前存下的那条草稿）' : `（草稿取自你上一轮给他看的那句：「${draftText}」）`}：\n${put}\n${done}\n` +
                '用你自己的话跟他说一声结果（成功就说好了；失败就如实说失败原因），别再问要不要做。',
            };
            if (topic === 'qzone') earlyCtx.refs.qzoneAt = 0;
            else earlyCtx.refs.profileAt = 0;
          } else if (topic) {
            auto = {
              label: '批准了但没找到草稿',
              result: `【系统】他刚批准了${topic === 'qzone' ? '发说说' : '改签名'}，但我**没能从你上一轮的话里认出正文**。别假装做了 —— 直接问他"你要发/改成哪句，给我原话"。`,
            };
          }
        }
        if (wantImg?.tool === 'find_image' && state.chat?.findImage !== false) {
          // 「再来两张」这类追问：搜索词用**上一次的**（refs 里记着）；一次都没搜过就问一句。
          const askQuery = String(wantImg.args?.query ?? '').trim() || String(earlyCtx.refs.lastImageQuery ?? '').trim();
          if (!askQuery) {
            auto = { ...wantImg, result: '我还不知道你要找什么的图 —— 说一句「找 X 的图片」我就去。' };
          } else {
          try {
            /**
         * **标签解析**（2026-10-10 用户要求）：`【白丝】【萝莉】洁尔佩塔` → 标签 + 角色名。
         * 标签**不是必须的**；说了就做"广泛匹配"（先两个都有，再单标签）。
         * 同时**两个来源都解析**：他这句话本身、以及意图识别抽出来的 query（哪边有算哪边）。
         */
        const tagInfo = parseTagQuery(text);
        const askTags = parseTagQuery(askQuery).tags;
        let tags = [...new Set([...tagInfo.tags, ...askTags])];
        /**
         * **用户明确说不要的标签**（2026-10-10 17:0x 要求：「我说不要【标签】发来的图，
         * 就不要带那个标签的」）—— 例「帮我找八重神子**不要r18**的图」。
         * 两个来源都解析（他这句话 + 意图抽出来的 query），下面一路传到搜索与筛图闸。
         */
        let exclude = [...new Set([...tagInfo.exclude, ...parseTagQuery(askQuery).exclude])];
        let imgQuery = (tagInfo.keyword || askQuery).trim() || askQuery; // let：角色确认后可能要换成正式名

        /**
         * **重名前先问清**（2026-10-10 用户要求：「胡桃（原神、BA）就要提前问是哪个游戏的」）。
         * 只在**他说的话没指明**哪个作品时才问 —— 说清了就直接搜。
         */
        const amb = state.imageSearch?.ambiguous ?? {};
        const ambGames = Object.keys(amb).find((k) => imgQuery === k || imgQuery.includes(k));
        /**
         * ⚠️ 2026-10-10 实测踩坑：配置的重名表从**数组**改成了 `{ works, name }` 对象，
         * 而这一行还在用 `.some(...)` → **TypeError: amb[...].some is not a function** ✗，
         * 每次找图都在这里炸（日志里连「有多个出处」那行都打不出来，她只能转述"工具报了个错"）。
         * 现在先归一化成数组再用；两种写法都认。
         */
        const ambWorksOf = (k) => {
          const e = amb[k];
          return Array.isArray(e) ? e : (e?.works ?? []);
        };
        if (ambGames && !ambWorksOf(ambGames).some((g) => text.includes(g))) {
          const games = ambWorksOf(ambGames).join(' 还是 ');
          // ⚠️ 2026-10-10 实测：原来问完**什么都不记** → 用户答「终末地的」回来时无处可接 ✗。
          //    挂上待答状态，下一句就能认出他选的是哪个（复用角色确认那条 pendingCharacter）。
          /**
           * ⚠️ 2026-10-10 实测：这里原来挂的是 `imgQuery`（= **整句话**「帮我找洁哥的白丝图」），
           * 于是① 角色表存了个垃圾键 ② 确认后用整句话去搜图 → 搜回来一堆无关网页图（筛图闸只好全筛掉）。
           * 正确做法：挂**命中的那个名字**（「洁哥」），并把配置里的**正式名**一起带上（「洁尔佩塔」）。
           */
          const ambEntry = amb[ambGames];
          const ambWorks = ambWorksOf(ambGames);
          const ambName = Array.isArray(ambEntry) ? '' : (ambEntry?.name ?? '');
          /**
           * ⚠️ **标签必须一起挂起**（2026-10-10 用户报的第一个问题）：
           * 他答「原神」那一刻，这句话里**没有任何标签** —— 不把上一轮解析出的
           * `tags`（这里是【r-18】）挂上的话，接下来那次搜索就是"光着搜"的，
           * 拿回来的根本不是他要的 R-18 图。
           */
          refs.pendingCharacter = { name: ambGames, works: ambWorks, canonical: ambName, tags };
          log.info(
            `[找图] 「${ambGames}」有多个出处 → 先问他要哪个（${games}）` +
              (tags.length ? `；挂起标签${tags.map((t) => `【${t}】`).join('')}，等他答完接着用` : ''),
          );
          await say(target, key, `「${ambGames}」这个名字有好几个——你说的是 ${games}？（说一句我就去找）`, '小笛·找图');
          return;
        }

        /**
         * **说 pixiv 号就直接下**（2026-10-10 用户：「也可以说 pixiv 好让他去下载发出来」）：
         * 认 `https://www.pixiv.net/artworks/12345` 或 `pixiv 12345` 这种写法。
         */
        const pixivId = (
          text.match(/pixiv\.net\/artworks\/(\d{5,12})/i) ||
          text.match(/\bpixiv\b[^\d]{0,12}(\d{5,12})/i) ||
          []
        )[1];
        if (pixivId) {
          const r0 = await sendPixivWork(target, key, pixivId, text, log);
          log.info(`[找图] pixiv 作品号 ${pixivId} → ${String(r0).replace(/\n/g, ' ').slice(0, 70)}`);
          return;
        }

        /**
         * **先上网搜角色 → 重名就问 → 再去找图**（2026-10-10 用户指定顺序）。
         * 实现见 `src/character.mjs`；这里只负责：答上一个问题 / 挂起新问题 / 带着确认结果去搜图。
         */
        const cmap = readCharacterMap();
        // (a) 上一轮我们问过"是哪个作品"，他现在回答了吗？
        if (refs.pendingCharacter?.works?.length) {
          const pending = refs.pendingCharacter;
          const answered = interpretPendingAnswer(pending, text);
          if (answered) {
            writeCharacterMap(answered.key, answered.saved, log);
            /**
             * ⚠️ 2026-10-10 这一支和上面 `!wantImg` 那一支是**同一段逻辑的两份拷贝**
             * （技术债见 HANDOFF 待办②）。现在两份都走 `interpretPendingAnswer`，
             * 顺手修掉这里原有的两个错：
             *   ① `imgQuery = searchWordFor(saved, refs.pendingCharacter?.name || imgQuery)` ——
             *      `pendingCharacter` 刚被置 null，等于永远退回 `imgQuery`，**正式名白解析了**；
             *   ② 标签没接回来（和用户报的第一个问题同源）。
             */
            tags = [...new Set([...answered.tags, ...answered.saved?.works ?? [], ...tags])];
            refs.pendingCharacter = null;
            imgQuery = answered.query;
            log.info(
              `[找图] 角色确认：「${pending.name}」→ ${answered.chose}（已记住）→ 用「${imgQuery}」去搜` +
                `（出处进筛选：${(answered.saved?.works ?? []).join('/') || '无'}）` +
                (answered.tags.length ? `（带回挂起的标签${answered.tags.map((t) => `【${t}】`).join('')}）` : ''),
            );
          } else if (!/不知道|算了|不用|取消/.test(text)) {
            // 没点候选、也没说取消 → 再问一次（别硬猜）
            await say(
              target,
              key,
              `「${refs.pendingCharacter.name}」我还是不确定是哪个 —— ${refs.pendingCharacter.works.join(" 还是 ")}？`,
              '小笛·找图',
            );
            return;
          }
        }
        // (b) 本地记过的名字直接用；没记过且看着像名字 → 上网确认
        const remembered = cmap[imgQuery];
        if (remembered?.name) {
          imgQuery = searchWordFor(remembered, imgQuery);
          // ⚠️ 记过的角色也要把**出处**带进筛选（不然「胡桃」又会搜到别的胡桃，见 17:0x 那条）
          if (remembered.works?.length) tags = [...new Set([...tags, ...remembered.works])];
        } else if (state.imageSearch?.resolveCharacter !== false && needResolve(imgQuery, { map: cmap, known: amb })) {
          try {
            const searchText = String(await execTool('web_search', { query: `${imgQuery} 角色 出自哪个作品`, count: 5 }));
            const out = await llm.chat({
              system: '你是资料整理助手。只按用户要求输出一个 JSON，不要解释。',
              messages: [{ role: 'user', content: buildResolveAsk({ name: imgQuery, searchText }) }],
              temperature: 0,
            });
            const res = parseResolveJson(out?.text ?? '');
            if (res && res.clear && res.name) {
              writeCharacterMap(imgQuery, { name: res.name, works: res.works }, log);
              log.info(`[找图] 角色确认：「${imgQuery}」→ ${res.name}${res.works.length ? `（${res.works[0]}）` : ''}（已记住）`);
              imgQuery = searchWordFor({ name: res.name, works: res.works }, imgQuery);
              // 出处进筛选（同上：只拿名字搜会把同名角色混进来）
              if (res.works?.length) tags = [...new Set([...tags, ...res.works])];
            } else if (res && res.works.length > 1) {
              // 标签同样要挂起 —— 理由见上面「先问后答」那一段（2026-10-10 用户报的第一个问题）。
              refs.pendingCharacter = { name: res.name || imgQuery, works: res.works, tags };
              log.info(
                `[找图] 角色确认：「${imgQuery}」有多个出处 → 先问用户（${res.works.join(" / ")}）` +
                  (tags.length ? `；挂起标签${tags.map((t) => `【${t}】`).join('')}` : ''),
              );
              await say(target, key, `「${res.name || imgQuery}」这个名字有好几个——你找的是 ${res.works.join(" 还是 ")}？（说一个我就去找）`, '小笛·找图');
              return;
            } else {
              log.info(`[找图] 角色确认：「${imgQuery}」没查到明确出处 → 照原词搜`);
            }
          } catch (err) {
            log.warn(`[找图] 角色确认失败（照原词搜）：${err.message}`);
          }
        }

        /**
         * **纯标签搜索**（2026-10-10 实测）：他说「找找白丝的图」→ 标签 = 白丝，
         * 而剥掉套话后关键词是空的 → 那就**直接用标签当搜索词**（不然会拿「找找的图」去搜，0 条）。
         */
        const bare = stripImageAskBoilerplate(imgQuery);
        const queryForSearch = bare || (tags.length ? tags.join(' ') : imgQuery);
        if (!bare && tags.length) {
          log.info(`[找图] 剥掉套话后没有角色名 → 直接用标签搜：${tags.map((t) => `【${t}】`).join('')}`);
        }
        // 排除标签：**搜索时就丢掉**，之后筛图闸还会再用一次（对没有标签的 Bing 图也有效）
        const r = await findAndSendImages(target, key, queryForSearch, { tags, exclude });
            auto = {
              ...wantImg,
              result:
                r +
                '（图已经由程序直接发出去了：**不要再写 [[网图:...]] 标记，也不要把图片链接贴成文字** —— ' +
                '用户点那些链接是打不开的。就说一句“给你捞了几张”即可。）',
            };
            // ⚠️ 这里以前打的是 `wantImg.args.query`：追问（「再来两张」）时它是空的，
            // 日志里就出现 `[找图] undefined` —— 偏偏那正是最需要对账的场景。改成实际用的搜索词。
            log.info(`[找图] ${askQuery} → ${r.replace(/\n/g, ' ').slice(0, 80)}`);
            earlyCtx.refs.lastImageQuery = askQuery;
          } catch (err) {
// ⚠️ 2026-10-10：错误原来只塞给模型（她只会转述成「工具报了个错」），**日志里看不到** ✗。
// 现在同时落盘，连 stack 一起打 —— 下次一眼能看到真实原因。
log.warn(`[找图] 这一段抛错了：${err?.stack ?? err?.message ?? err}`);
            auto = { ...wantImg, result: `没成：${err.message}` };
          }
          }
        }
        if (!auto && (controlAllowed(state, earlyCtx) || qqactAllowed(state, earlyCtx) || biliActAllowed(state, earlyCtx))) {
          // 账号自理的"点头"由代码判：把**待审草稿的种类**传进去（见 intents.mjs 顶部那段说明）
          const hit = matchIntent(text, { refs: earlyCtx.refs, pending: draftKind(key) });
          if (hit) {
            try {
              // ⚠️ 必须走 `execTool`（它同时分发控制类**和提醒类**工具）。
              // 2026-10-07 踩过：这里原本写的是 `runControlTool`，于是路由命中「提醒我…」后
              // 被它一句「没有叫 set_reminder 的控制工具」顶回来 —— **路由把本来偶尔能用的
              // 提醒功能变成了必定失败**（比不改更差）。
              const result = String(await execTool(hit.tool, hit.args, earlyCtx));
              auto = { ...hit, result };
              if (hit.tool === 'media_control') earlyCtx.refs.lastMedia = Date.now();
              log.info(`[意图] 代码直接执行 ${hit.tool}(${JSON.stringify(hit.args)}) → ${result.replace(/\n/g, ' ').slice(0, 90)}`);
              note({ scope, key, who: '工具', text: `${hit.tool}(${JSON.stringify(hit.args)}) → ${result.slice(0, 60)}` });
            } catch (err) {
              log.warn(`意图路由执行失败：${err.message}`);
            }
          }
        }
      }

      /**
       * 记忆整理：他说「整理一下记忆」就**真的整理一遍**（代码触发；模型只负责从对话原文里挑句子），
       * 结果做成草稿**先发他审批** —— 不回就不记（错事实进档案会污染之后每一次对话）。
       */
      if (!auto && controlAllowed(state, ctxBase) && /整理.{0,4}记忆|记忆.{0,4}整理|记一下.{0,6}(长期|档案)/.test(text)) {
        try {
          const r = await consolidate(key, ctxBase.userId, target);
          auto = r.ok
            ? {
                label: '整理长期记忆',
                result: `草稿已经发给他了（${r.count} 条），在等他审批。请**简短**说一句让他过目，**不要重复草稿内容**，更不许说「我记下了」`,
              }
            : { label: '整理长期记忆', result: `这次没整理成：${r.why}` };
        } catch (err) {
          auto = { label: '整理长期记忆', result: `整理那一步出错了：${err.message}` };
        }
      }

      // 日期锚点算一次（下面拼消息时用）—— 今天/昨天/前天/明天/后天 + 星期
      const anchor = timeAnchor(state.llm?.timezone ?? 'Asia/Shanghai');
      const messages = [
        ...sessions.toMessages(key, { label: isGroup }),
        {
          role: 'user',
          content:
            (isGroup ? `${speaker}：${textForModel}` : textForModel) +
            /**
             * **当前时间必须每轮给**：它上下文里没有时钟，而 `get_time` 它不一定调
             * （2026-10-07 实测：问「今天日期是什么」它一次都没调，直接编了个「8 月 20 号」）。
             * 放**最后一条消息**而不是 system：时间是每分钟都变的，塞进 system 会把前缀缓存
             * 每分钟打断一次；放在这里既不影响缓存，又是离提问最近的位置。
             */
            `\n\n（参考时间：${nowLabelShort()}　只在你需要判断时间时用，**不要主动报时间、别每句都提**）` +
        /**
         * ⚠️ **日期锚点**（2026-10-11 加，起因是用户说「他对时间（星期几、昨天这种）不太敏感」）：
         * 光给"现在几点"不够 —— "昨天是几号/周几"要模型**自己算日期**，而它算日期最容易错。
         * 这里直接替它算好**今天/昨天/前天/明天/后天**，一行、约 25 token，零成本消掉全部日期算术。
         */
        (anchor ? `\n（日期对照：${anchor}）` : '') +
            (auto
              ? `\n\n【系统】我已经**真的执行**了「${auto.label}」，真实结果是：${auto.result}\n把结果如实告诉他，**不要重复执行**同一个动作（播放/暂停是开关，按两次就白按了）。`
              : ''),
        },
      ];
      try {
        const started = Date.now();
        const tone = toneHint({ text, isMaster: fromMaster }); // 一轮只取一次；带上他这句话 + 是不是主人（对主人少傲娇一点）
      /**
       * **这一轮用哪档称呼**（2026-10-12 用户指定：暧昧=亲昵、平常=老大/主人、犯贱=杂鱼）。
       * 只对主人判 —— 对别人绝不能出现「亲爱的/宝贝」这种（比叫错"主人"更糟）。
       * 判据保守：命中难过/正经信号就一律退回 normal。
       */
      if (fromMaster) {
        tone.addressScene = pickAddressScene(text, { vocab: state.master?.address ?? {} });
        /**
         * ⚠️ **让称呼的判定在日志里留痕**（2026-10-12 加）：
         * 用户说"看到她叫我老大了"，可我在日志里**查不到任何「老大」** ——
         * 这个功能**在日志里看不见**，出了分歧只能靠猜。所以每轮记一行判定结果：
         * 之后对不上时，能直接看到"这轮判成了哪档"，而不是靠翻聊天记录反推。
         * （只记场景与是否主人，不记正文，别把日志撑爆。）
         */
        log.info(`[称呼] 判定=${tone.addressScene}（主人 · ${tone.addressScene === 'normal' ? `老大/${state.master?.title || '主人'}` : tone.addressScene === 'flirty' ? '亲爱的/宝贝' : '杂鱼'}）`);
      }
        /**
         * 控制类工具的准入上下文。**身份在这里现算，模型看不到也改不了**：
         * 不是私聊、不是主人 → 工具定义根本不会注入。
         */
        const toolCtx = ctxBase;
        /**
         * ⚠️ **"他在问过去的事"时给一句提示**（2026-10-11 用户要「让他去对着时间找」）：
         * 归档**默认不进上下文**（0 token），只有模型主动调 `recall_chat` 才查得到。
         * 但实测模型不一定想到去调 —— 所以在**识别到时间线索**的那些轮里，
         * 往系统提示尾巴补一行（约 30 token，且只在这类消息上补），把 `when` 该填什么告诉它。
         * 线索认不出就不补（不花任何代价）。
         */
        const timeHint = timeRecallHint(text);
        // 接歌/问歌的提示（涉及歌词必须查真实的，别背 —— 模型背歌词最容易记串）
        const songHint = singHint(text);
        /**
         * ⚠️ **他批准记忆草稿 → 由代码落盘，不指望模型想起来**（2026-10-13 加）。
         *
         * 实证事故（用户 2026-10-13 报「我记得 PCB 那个草稿我说过让她记了」）：
         * ```
         * 22:19:18  [记忆] 草稿已发（6 条）
         * 22:41:51  他：「记」                      ← 他确实批准了 ✓
         * 22:42:04  [warn] 模型说记下了，但没调 memory_review —— 档案没动  ✗✗
         * 22:42:16  她：「好，记下了。」            ← 谎话；事实一条都没进档案 ✗
         * ```
         * 根因：落盘**完全靠模型自己想起来调 `memory_review`** ✗ —— 而它没调。
         * 这正是本项目反复踩的同一个坑（链接、读图都栽过）：
         * **"指望模型想起来"的事，就该由代码保证** ✓。
         *
         * 做法：草稿挂着 + 他这句**明显是批准**（`isDraftApproval`：短句、且没有"第X条/去掉/删/改"这类
         * 选择或否定 ✗）⇒ **这里直接落盘**，再往提示里塞一句"已经替你落盘了 N 条" ✓，
         * 于是她不必（也不该）再调 `memory_review`，更不会再出现"说记下了但档案没动" ✗。
         * 选择性答复（「第 2 条去掉」）**不在这里处理** ✓ —— 那种仍交给模型调工具 ✓。
         */
        let memHint = '';
        try {
          const uidForMem = String(evt?.user_id ?? '');
          const openDraft = !auto && uidForMem ? memory.draft(uidForMem) : null;
          if (openDraft && isDraftApproval(text)) {
            const r = await execTool('memory_review', { approve_all: true }, toolCtx);
            const n = (openDraft.items ?? []).length;
            if (/落|存|记|approved|已/.test(String(r))) {
              log.info(`[记忆] **代码替他落盘了**（草稿 ${n} 条，他说的「${text.slice(0, 12)}」= 批准）`);
              memHint = `\n\n【记忆】他刚批准了那份草稿（${n} 条），**代码已经替你落盘了** —— 你只要简短应一句（"记好了/收着了"），**不要再调 memory_review**，也别说"我去记"（已经记完了）。`;
            } else {
              log.warn(`[记忆] 自动落盘失败：${String(r).slice(0, 120)}`);
              memHint = `\n\n【记忆】他批准了草稿，但**落盘失败了** —— 如实跟他说一句"没存上"，别说"记下了"。`;
            }
          }
        } catch (err) {
          log.warn(`[记忆] 自动落盘出错：${err.message}`);
        }
        const sys =
          composeSystemFor(evt?.user_id, evt?.sender?.nickname, tone, isGroup, toolCtx) +
          (timeHint ? `\n\n${timeHint}` : '') +
          (songHint ? `\n\n${songHint}` : '') +
          memHint;
        // 代码已经做过了 → 这一轮**收回控制类工具**，免得同一个开关被按两次
        const tools = activeTools(toolCtx, { withControl: auto === null });
        /**
         * ⚠️ **发"正在输入"状态**（2026-10-12，用户要求：「我看网上说要有对方正在输入才可以避免」）。
         *
         * 时机**故意放在"开始生成"之前**：生成一次要 1~13 秒，这段时间对方屏幕上显示
         * 「对方正在输入…」—— 这是**最像人的一刻**（人也是先开始打字、再发出来）。
         *
         * 事实核查：NapCat 支持 `set_input_status`（[官方 API 文档](https://napneko.github.io/onebot/api)）✓；
         * 但**"能防封"我无法证实**（社区说法、没有官方依据）✗ —— 方向合理、成本近零、无副作用，
         * 所以做上；**别把它当护身符**。
         * 只对**私聊**做（接口参数是 `user_id`，群里没有对应语义）。
         */
        const typingOn = state.chat?.typingIndicator !== false && !isGroup && scope === 'private';
        const typingUser = typingOn ? String(evt?.user_id ?? '').replace(/^private:/, '') : '';
        /**
         * 实际停顿（毫秒）。**为什么要留着这个变量**（2026-10-13）：
         * 我想验证"抖动调小"有没有生效，却发现**从日志里量不出来** ✗ ——
         * 因为"收到消息 → 回复日志行"之间还夹着合并窗口、分段发送、冷却，全都混在一起
         * （我算出来的中位 7~8 秒是这一堆的总和，不是抖动 ✗）。
         * ⇒ 干脆把**真正应用的停顿**打进回复日志行，以后一眼能验 ✓。
         */
        let replyWaitMs = 0;
        if (typingOn) void onebot.setInputStatus(typingUser, state.chat?.typingEventType ?? 1);
        const out = tools.length
          ? await toolChat({
              system: sys,
              messages,
              tools,
              toolContext: toolCtx,
              maxRounds: state.tools?.maxRounds ?? 4,
              onToolCall: (c) =>
                note({ scope, key, who: '工具', text: `${c.name}(${JSON.stringify(c.args)})` }),
            })
          : await llm.chat({ system: sys, messages });
        /**
         * **发之前的随机停顿**（2026-10-12 用户要求「回复延迟加抖动」）。
         *
         * 为什么：日志里 1458 条回复的**中位延迟只有 1531ms**、而且几乎是恒定值 ——
         * 「永远 1.5 秒回」本身就是一个机器特征（人会走神、会打字、会放下手机）。
         * 所以加两层抖动：
         *   ① 基础抖动 `replyJitterMs`（默认 0.3~1.8 秒随机）；
         *   ② **长尾**：`replyLongChance`（默认 12%）的概率再加 2.5~7 秒（模拟"在忙/走神"）。
         * 再加上"正在输入"那段停顿（`typingHoldMs`），总延迟大约 1~4 秒、偶尔十几秒 —— 更像人。
         */
        {
          const [lo, hi] = Array.isArray(state.chat?.replyJitterMs) && state.chat.replyJitterMs.length === 2
            ? state.chat.replyJitterMs
            : [300, 1800];
          let waitMs = Number(lo) + Math.random() * Math.max(0, Number(hi) - Number(lo));
          if (Math.random() < (Number(state.chat?.replyLongChance) ?? 0.12)) {
            const [l2, h2] = Array.isArray(state.chat?.replyLongMs) && state.chat.replyLongMs.length === 2 ? state.chat.replyLongMs : [2500, 7000];
            waitMs += Number(l2) + Math.random() * Math.max(0, Number(h2) - Number(l2));
          }
          if (typingOn && state.chat?.typingHoldMs !== 0) {
            const [t1, t2] = Array.isArray(state.chat?.typingHoldMs) && state.chat.typingHoldMs.length === 2 ? state.chat.typingHoldMs : [400, 1100];
            waitMs += Number(t1) + Math.random() * Math.max(0, Number(t2) - Number(t1));
          }
          replyWaitMs = waitMs;
          if (waitMs > 0) {
            log.debug?.(`回复前停顿 ${Math.round(waitMs)}ms（抖动）`);
            await new Promise((r) => setTimeout(r, waitMs));
          }
        }
        const ms = Date.now() - started;
        let reply = (out.text ?? '').trim();
        if (!reply) reply = '（模型返回了空内容）';
        /**
         * **硬修「同一个梗连着刷」**（2026-10-09 用户问「日历那个真修不了吗」）：
         * 提示词里那句软提醒（`repeatNote`）可能被忽略，所以这里再加一道**生成后检测**：
         * 命中就**重新生成一次**（只一次，不无限重试）；重生成后还命中就照原样发出去
         * —— 宁可发一条略有重复的话，也不能在这里卡住或空回复。
         */
        {
          const selfTexts = sessions
            .history(key)
            .filter((m) => m.role === 'assistant')
            .slice(-8)
            .map((m) => (typeof m.content === 'string' ? m.content : ''));
          const dup = repeatedGimmicks([...selfTexts, reply], { min: 2 });
          if (dup.length) {
            const names = dup.map((d) => d.name).join('、');
            try {
              const retry = await llm.chat({
                system:
                  `${sys}\n\n【重要：换个说法】你刚刚那句话又在用「${names}」这个老梗（最近已经用过好几次了）。` +
                  '重写一遍：**不要再用那个格式**，也别解释这件事，直接用别的方式说这句话。',
                messages,
              });
              const retryText = String(retry?.text ?? '').trim();
              if (retryText && !repeatedGimmicks([...selfTexts, retryText], { min: 2 }).length) {
                reply = retryText;
                log.info(`[语气] 检测到重复梗（${names}）→ 已重新生成一版`);
              } else {
                log.info(`[语气] 检测到重复梗（${names}），但重生成后仍有 → 这次照原样发`);
              }
            } catch (err) {
              log.warn(`[语气] 重复梗重生成失败：${err.message}（照原样发）`);
            }
          }
        }
        if (reply.length > state.limits.maxReplyChars) {
          reply = reply.slice(0, state.limits.maxReplyChars) + '…';
        }

        // 嘴上报了个动作、其实没做 —— 2026-10-07 真发生过三次（「停了。」「抓到了，我截了并发出去了」）。
        // 除了记 warn，这里**补一句实话**：用户被骗一次就会开始不信它说的任何结果，代价比一句难听话大得多。
        // ⚠️ 判据挪进 `honesty.mjs` 的 `controlActionClaim()`（可单测），并修了 2026-10-11 的误报：
        //    裸 `抓到了` 会把「被我抓到了哦」这种闲聊判成撒谎。
        const usedControl = (out.transcript ?? []).some((t) => CONTROL_TOOL_NAMES.has(t.name));
        const actionClaim = usedControl ? '' : controlActionClaim(reply);
        if (!auto && actionClaim) {
          log.warn(`模型嘴上说做了某个动作（「${actionClaim}」），但这一轮没有任何控制类工具调用 —— 那句是空的`);
          /**
           * ① 先保证**事实**到用户眼前（这句是死的，不靠模型转述）；
           * ② 再告诉它怎么说 —— 不然后果是它开始自我贬低。
           * 2026-10-07 实感：反复注入「我错了」这种自白句，会把上下文染成一片道歉，
           * 模型只会顺着这个调子往下走，聊天气氛直接垮掉（用户原话：「我感觉他心情已经不好了」）。
           * ⚠️ 2026-10-11：文案改成**说清是哪一类**（原来只说「我没真的做到」，用户看了莫名其妙）。
           */
          reply += '\n\n（说实话：这一轮我没真的去操作电脑（截图/关掉/按按钮这类），上面那句别信。）';
        }
        if (
          !auto &&
          remindersAllowed(state, toolCtx) &&
          looksLikeReminderAsk(text) &&
          promisesReminder(reply) &&
          !(out.transcript ?? []).some((t) => REMINDER_TOOL_NAMES.has(t.name))
        ) {
          log.warn('模型说要提醒，但没调 set_reminder —— 这条承诺是空的');
          /**
           * 和上面那条同样的处理：**事实先落地**（这句是死的），再给语气指引。
           * 千万别只丢一句自白——它会把整段对话的调子带沉（用户能直接感觉出来）。
           */
          reply += '\n\n（说实话：这一轮我没真的设上提醒，上面那句别信。）';
        }
        // 待审批的记忆草稿还挂着，它却说「记下了」→ 同一个谎话闸（档案其实没动）
        if (
          !auto &&
          memory.draft(ctxBase.userId) &&
          /(记下了|记住了|已经记下|已经记住|我给你记上)/.test(reply) &&
          !(out.transcript ?? []).some((t) => MEMORY_TOOL_NAMES.has(t.name))
        ) {
          log.warn('模型说记下了，但没调 memory_review —— 档案没动');
          reply += '\n\n（说实话：这一轮我没真的记下，档案还没动。）';
        }
        /**
         * ⚠️ **账号动作的谎话闸**（2026-10-08 实测加的）：
         * 用户说「你去给BV…点个赞」，它**一次工具都没调**，却回了
         * 「点完啦，赞已经在上面了」。（更正：那个 BV 号是用户自己打错的，它只是照抄 ——
         * 真正的问题只有一个：**说了却没做**。）
         * 账号动作是**不可自证**的（用户看不见我的日志），所以这里必须由代码兜底：
         * **嘴上说了动作、这一轮却没有对应工具调用 → 日志 warn + 回复末尾补一句实话。**
         * 判据抽在 `src/honesty.mjs`（纯函数，能测 —— 不然这类安全网只能靠真跑一遍才知道有没有用）。
         */
        if (!auto) {
          const ran = new Set((out.transcript ?? []).map((t) => t.name));
        /**
         * 备用闸：如果哪次改动**确实没生效**且有可靠证据（`refs.profileBadAt`），
         * 就把"调过工具"这份成功证据撤掉，让它再嘴硬会被当场补一句实话。
         * ⚠️ 2026-10-09 记一笔：我原先用它处理"回读昵称没变"，**结果回读源本身是缓存值、骗了我**，
         * 那条判定已撤（见 qqact.mjs 里那段）。这个闸留着给**将来真正可信的失败证据**用。
         */
        if (Number(ctxBase.refs?.profileBadAt ?? 0) && Date.now() - Number(ctxBase.refs.profileBadAt) < 120000) {
          ran.delete('qq_confirm');
          ran.delete('qq_profile_set');
        }
          // 传 `userText`：多一道"他确实要求了这件事"的判断，免得把「我看别人点赞了」这种闲聊当成撒谎。
          // 另外把**热着的话题**传进去：他说「可以，这个可以」时句子里没有"说说/签名"，
          // 全靠这个 topic 才认得出"他现在是在说这件事"（今天在两个话题上各漏过一次）。
          const nowHot = (ts) => Boolean(ts) && Date.now() - ts < 30 * 60 * 1000;
          const topicNow = nowHot(ctxBase.refs?.profileAt) && !nowHot(ctxBase.refs?.qzoneAt)
            ? 'profile'
            : nowHot(ctxBase.refs?.qzoneAt)
              ? 'qzone'
              : '';
          for (const miss of claimMismatch(reply, ran, { userText: text, topic: topicNow })) {
            log.warn(`模型说完成了「${miss.label}」，但这一轮没调 ${miss.tools.join('/')} —— 账号其实没动`);
            reply += honestNote(miss.label);
          }
          /**
           * **"凭空赖工具"**（2026-10-10 实测）：她说「工具报了个错，图发不出去」，
           * 而那一轮 **0 次工具调用、0 条报错** —— 这是甩锅，比邀功更难发现。
           * 没调过工具就不许这么说；改了之后**当场更正**，别让她把锅甩给工具。
           */
          {
            const blame = toolBlameMismatch(reply, ran);
            if (blame) {
              log.warn(`[谎话闸] ${blame}`);
              reply += '\n\n（更正：这次**没有工具报错**，是我没办成，别赖工具。）';
            }
          }
        }

        // 网图放行闸。**私聊和群里都放行**（用户明确不要色图，那就没必要再按场景卡）。
        // 剩下的三道是卫生问题：数量上限、必须是本次搜出来的、目标主机不能是内网。
        const allowWebImage = createWebImageGate({ max: state.chat?.maxWebImages ?? 4 });

        // 把 [[图:标签]] / [[网图:URL]] 换成真实图片段；不认的标记直接丢掉，不打断这句话
        const { segments, unknownTags, rejectedWeb, toolMarkers } = splitReply(reply, stickers, { allowWebImage });
        if (unknownTags.length) log.warn(`模型点了库里没有的表情：${unknownTags.join('、')}`);
        // 模型把"工具调用"写成了正文里的标记（`[[qq_profile_set:…]]`）—— 已吃掉，但要留痕：
        // 说明它想调工具却没走 function calling（2026-10-09 实测：那条标记**真的发到用户眼前了**）。
        if (toolMarkers?.length) log.warn(`模型把工具调用写进了正文（已拦下，没发给用户）：${[...new Set(toolMarkers)].join('、')}`);
        if (rejectedWeb.length) {
          log.warn(`拦下 ${rejectedWeb.length} 张网图（不在本次搜索结果里 / 超过数量上限 / 或指向内网）`);
        }

        // 「嘴硬的时候句末加 ~」是纯机械改写，交给代码保证（模型对标点不可靠）
        const bratty = tone.mayBrat || looksBratty(reply);
        let styled = state.tone?.bratTilde === false ? segments : bratTildeSegments(segments, { bratty });
        // 图发不出去时别把用户要的东西吞了，至少把链接给出去
        if (rejectedWeb.length) {
          styled = [
            ...styled,
            { type: 'text', text: `（这几张我发不出来，链接给你：\n${rejectedWeb.slice(0, 4).join('\n')}）` },
          ];
        }

        // 点歌：把 [[歌:关键词]] 搜成 QQ音乐卡片。**搜不到就换成一句说明**——
        // 不能让用户对着一条空消息等，也不能让标记原样漏出去。
        let musicCount = 0;
        const maxMusic = state.music?.maxPerReply ?? 1;
        const withMusic = [];
        for (const seg of styled) {
          if (seg.type !== 'music') {
            withMusic.push(seg);
            continue;
          }
          if (state.music?.enabled === false) {
            log.warn('点歌被跳过：功能已关');
            continue;
          }
          if (musicCount >= maxMusic) {
            withMusic.push({ type: 'text', text: `（一条回复最多放 ${maxMusic} 首，这首先欠着）` });
            continue;
          }
          const song = await findSong(seg.query);
          if (song) {
            musicCount += 1;
            // **不能只带 songmid**：NapCat 是拿这些字段去调第三方「音乐卡片签名服务」的，
            // 只给 {type,id} 会被签名服务判 400「缺少 title」，卡片随即被静默丢掉
            // （接口照样返回 retcode 0）。所以把 title/singer/url/image 一起带上。
            withMusic.push({
              type: 'music',
              songmid: song.songmid,
              title: song.name,
              singer: song.singer,
              url: song.url,
              image: song.cover,
            });
            log.info(`点歌：${seg.query} -> ${song.name}${song.singer ? ` / ${song.singer}` : ''} (${song.songmid})`);
          } else {
            log.warn(`点歌没搜到：${seg.query}`);
            withMusic.push({ type: 'text', text: `（没找到《${seg.query}》，换个歌名再跟我说？）` });
          }
        }

        // 语音：QQ 的**群 AI 语音是单独一条消息**，不能混进富消息里，
        // 所以先摘出来，正文发完再发语音。
        const voiceTexts = [];
        const body = [];
        for (const seg of withMusic) {
          if (seg.type !== 'voice') {
            body.push(seg);
            continue;
          }
          if (state.voice?.enabled === false) continue;
          if (voiceTexts.length < (state.voice?.maxPerReply ?? 1)) voiceTexts.push(seg.text);
        }

        const rich = buildRichSegments(body, (p) => log.warn(`表情包文件读不到，已跳过：${p}`));
        // 万一整条回复只剩图片、而图片全读不到，就把标记剥掉当纯文本发，别发空气
        if (rich.length === 0) rich.push({ type: 'text', text: stripImageMarkers(reply) || '……' });
        const imageCount = rich.filter((s) => s.type === 'image').length;
        const plain = rich.filter((s) => s.type === 'text').map((s) => s.text).join(' ');

        // 像人一样分成几条消息发。**第一条失败才算整体失败**——后面某条失败的话，
        // 用户其实已经看到内容了，不该把整轮当成没发生。
        const bubbles = ensureTextWithMusic(
          state.chat?.bubbles === false
            ? [rich]
            : splitIntoBubbles(rich, { maxBubbles: state.chat?.maxBubbles ?? 4 }),
        );
        // 把每一段的构成记下来。之前只记"2 段"，卡片丢了我完全看不见——
        // 这是本项目反复吃的亏：**不可观测就等于没有**。
        log.info(`发送分段：${bubbles.map((b) => `[${describeSegments(b)}]`).join(' ')}`);

        let ok = true;
        for (let i = 0; i < bubbles.length; i += 1) {
          if (i > 0) {
            await new Promise((r) =>
              setTimeout(
                r,
                bubbleDelayMs(bubbles[i], {
                  base: state.chat?.delayMs ?? 1200,
                  perChar: state.chat?.delayPerChar ?? 45,
                  max: state.chat?.delayMax ?? 4500,
                }),
              ),
            );
          }
          // 网图**先下载再发**：拉不到就丢掉（宁可不发，也不给你一个打不开的链接）
        const { segments: sendSegs, dropped } = await localizeWebImages(bubbles[i]);
        if (dropped) {
          log.warn(`本段有 ${dropped} 张网图没拉下来，已丢掉（不贴失效链接）`);
          const lastText = [...sendSegs].reverse().find((s) => s.type === 'text');
          if (lastText) lastText.text += `\n（有 ${dropped} 张图我没拉下来，就不贴失效链接了~）`;
        }
        /**
       * ⚠️ **引用回复**（2026-10-14 用户要求「引用回复要做」✓）：
       * 他**引用着某条**跟你说话时 ✓，你回的话也**引用他那条** ✓ ——
       * 上下文一眼就对得上（TG 的引用是原生能力 ✓）。
       * 他没引用就不引用 ✗（每句都带引用会很吵 ✓）；想关掉：`chat.quoteBack: false` ✓。
       */
      const quoteBackTo = state.chat?.quoteBack !== false && replySeg ? String(evt?.message_id ?? '') : '';
      const sent = await onebot.trySendRich(target, sendSegs, quoteBackTo ? { replyTo: quoteBackTo } : {});
          if (!sent) {
            if (i === 0) {
              ok = false;
              break;
            }
            log.warn(`第 ${i + 1} 段没发出去，但前面 ${i} 段已经发出去了`);
          }
        }

        if (ok) {
          // 正文发完再发语音（QQ 的群 AI 语音是独立消息）
          for (let i = 0; i < voiceTexts.length; i += 1) {
            await new Promise((r) => setTimeout(r, 500));
            // **代码闸**：同一会话里两次语音至少隔 minIntervalMs。
            // 提示词已经写了"只有被明确要求才发"，但那种要求光靠措辞不可靠
            // （本项目的教训：禁止性措辞要么被忽略、要么被过度执行），所以这里再兜一道。
            const gap = state.voice?.minIntervalMs ?? 300000;
            const last = lastVoiceAt.get(key) ?? 0;
            if (Date.now() - last < gap) {
              log.info(
                `语音被间隔闸挡下（距上次 ${Math.round((Date.now() - last) / 1000)}s < ${Math.round(gap / 1000)}s）：${voiceTexts[i].slice(0, 30)}`,
              );
              continue;
            }
            // 私聊的 AI 语音要靠 get_ai_record 生成，而它必须带 group_id，
            // 所以拿一个机器人所在的群当 fallback（音色表也是按群给的）。
            const fbGroup = (state.whitelist?.groups ?? [])[0] ?? state.voice?.fallbackGroupId;
            const sentVoice = await onebot.sendAiVoice(target, voiceTexts[i], state.voice?.character, {
              fallbackGroupId: fbGroup,
            });
            if (sentVoice) {
              lastVoiceAt.set(key, Date.now());
              note({ scope, key, who: '小笛（语音）', text: voiceTexts[i] });
            } else {
              log.warn(`语音没发出去：${voiceTexts[i].slice(0, 40)}`);
            }
          }
          // 上下文里保留原始标记，模型才记得自己会发图
          sessions.record(key, text, reply, speaker);
          const used = out.transcript?.length ?? 0;
          /**
           * **把 token 用量也打进日志**（2026-10-12 加）：
           * 起因是「第一条回复花了 12.7 秒」这种问题只能靠猜 —— 有了这行就能一眼看出
           * 慢在哪（提示词多大、前缀缓存命中多少、思考有没有偷偷开着、输出多长）。
           * 格式：`tok 1230(+1024命中)/9` = prompt 1230、其中 1024 命中缓存、输出 9。
           */
          const u = out.usage ?? {};
          const tokNote = u.prompt_tokens
            ? `, tok ${u.prompt_tokens}${u.prompt_cache_hit_tokens ? `(+${u.prompt_cache_hit_tokens}命中)` : ''}/${u.completion_tokens ?? 0}`
            : '';
          log.info(
            `[${scope}] ${key} 回复（${ms}ms, ${out.provider ?? state.llm.provider}/${out.model ?? state.llm[state.llm.provider]?.model ?? '-'}` +
              `${used ? `, ${used} 次工具` : ''}${imageCount ? `, ${imageCount} 张图` : ''}` +
              `${bubbles.length > 1 ? `, ${bubbles.length} 段` : ''}${tokNote}` +
              `${replyWaitMs > 0 ? `, 停顿 ${Math.round(replyWaitMs)}ms` : ''}）：${plain.slice(0, 120)}`,
          );
          note({ scope, key, who: '小笛', text: plain, images: imageCount, ms });
          // 发完了 → 收掉"正在输入"状态（否则对方那边会一直显示她在打字）
          if (typingOn) void onebot.setInputStatus(typingUser, state.chat?.typingStopEventType ?? 0);
        } else {
          sessions.recordUserOnly(key, text, speaker);
        }
      } catch (err) {
        sessions.recordUserOnly(key, text, speaker);
        log.error(`生成回复失败：${err.message}`);
        note({ scope, key, who: '错误', text: err.message });
        await onebot.trySend(target, '我这边出了点问题，等下再试。');
      }
    });
  }

  onebot.on('event', (evt) => {
    /**
     * **归档：每条消息都记**（含我们不理的群消息）—— 用户要的是"7 天内所有聊天记录"。
     * ⚠️ 放在 `handle()` **之前**且**不等它**：归档是旁路，不许影响判定与回复；
     * 图片走 ChatArchive 内部的后台队列，所以这里不会因为下图片而卡住。
     */
    if (chatArchive && evt?.post_type === 'message' && Array.isArray(evt?.message)) {
      const isGroup = evt.message_type === 'group';
      Promise.resolve(
        chatArchive.recordIncoming({
          scope: isGroup ? 'group' : 'private',
          key: `${isGroup ? 'group' : 'private'}:${isGroup ? evt.group_id : evt.user_id}`,
          sender: { id: evt.user_id, nickname: evt.sender?.nickname },
          message: evt.message,
          // 存下这条消息自己的 id：别人引用它时，归档能查回原文（引用自包含）
          id: evt.message_id,
          at: Number(evt.time) > 0 ? Number(evt.time) * 1000 : Date.now(),
          selfId: onebot.selfId,
        }),
      ).catch((err) => log.warn(`[归档] 记录失败（不影响聊天）：${err.message}`));
    }
    handle(evt).catch((err) => log.error(`处理事件出错：${err.stack ?? err.message}`));
  });
  onebot.on('log', ({ level, msg }) => log[level]?.(msg));
  onebot.on('error', (err) => log.error(`OneBot 错误：${err.message}`));
  onebot.on('open', () => writeStatus());
  onebot.on('close', () => writeStatus());

  const sweeper = setInterval(() => {
    const n = sessions.sweep();
    if (n) log.debug(`清理了 ${n} 个过期会话`);
    // 归档的滚动清理挂在这里：很便宜（只读一次目录），10 分钟一次足够跨天自愈；
    // 顺手给"当前这一小时"的档刷一次摘要（用户要的"档里有摘要"，侧车文件，幂等覆盖）
    chatArchive?.prune();
    chatArchive?.refreshCurrentSummary();
  }, 10 * 60 * 1000);
  sweeper.unref?.();

  // 定期刷新快照，面板上的「已连接」才不会一直是旧值
  const heartbeat = setInterval(writeStatus, 15 * 1000);
  heartbeat.unref?.();

  /* ---------------- 主动开口 ---------------- */
  const pingState = new Map(); // key -> { lastPingAt, day, count }

  async function runProactive({ force = false } = {}) {
    refreshStickersIfChanged();
      refreshMemesIfChanged();
    const pcfg = state.proactive;
    if (!force && !pcfg?.enabled) return;
    const now = Date.now();
    const day = new Date(now).toDateString();

    for (const s of sessions.snapshot()) {
      const target = parseSessionKey(s.key);
      if (!target) continue;
      if (target.type === 'group' && !pcfg?.groups) continue;
      /**
       * ⚠️⚠️ **只主动找"当前传输层"的会话**（2026-10-15 修的真 bug ✗）。
       *
       * 起因：用户报「今晚聊天逻辑好像有点问题」✓ —— 查日志发现当天有 **132 条**失败 ✓，
       * 绝大多数是 `Bad Request: chat not found` ✗：主动开口（冲浪）遍历 `sessions.json` 时，
       * 里面**还留着换传输层之前的 QQ 会话**（`private:10000000` ✗）⇒ 拿着 QQ 号去 TG 发，
       * **那个 chat 根本不存在** ⇒ 她**永远主动不开口** ✓（而被动回复是好的 ✓，因为回谁就用谁的 chat ✓）。
       *
       * 规矩：QQ 模式只找 QQ 的会话 ✓，Telegram 模式只找 **`telegram.masterUserId`** 那个私聊 ✓。
       * （两个传输层的会话可以在 sessions.json 里共存 ✓ —— 只是**别跨线发** ✓。）
       */
      if (target.type === 'private') {
        const tgMaster = String(state.telegram?.masterUserId ?? '').trim();
        const isTgSession = tgMaster && String(target.id) === tgMaster;
        if (state.transport === 'telegram' && !isTgSession) {
          log.debug(`主动开口跳过 ${s.key}：不是 Telegram 的会话（换了传输层之后的旧会话别跨线发）`);
          continue;
        }
        if (state.transport !== 'telegram' && isTgSession) {
          log.debug(`主动开口跳过 ${s.key}：这是 Telegram 的会话，当前跑的是 QQ`);
          continue;
        }
      }

      const st = pingState.get(s.key) ?? { lastPingAt: 0, day, count: 0 };
      if (st.day !== day) {
        st.day = day;
        st.count = 0;
      }
      // force 用来做「立刻试一次」：绕过时机/免打扰判断，但仍然每次只挑一个会话
      const v = force
        ? { ping: true, reason: '手动触发' }
        : shouldPing({
            now,
            lastActivityAt: s.lastAt,
            lastPingAt: st.lastPingAt,
            pingsToday: st.count,
            cfg: pcfg,
          });
      if (!v.ping) {
        log.debug(`主动开口跳过 ${s.key}：${v.reason}`);
        continue;
      }

      try {
        // 用一个「当前任务」追加在 system 后面，而不是伪造一条用户消息——
        // 后者会污染上下文，让模型以为对方真的说了那句话。
          // ⚠️ 主动开口是我自己起的头，没有"他这句话"，传空串 —— 千万别引用下面才声明的 text
        const tone = toneHint({ text: '' }) // 主动开口没有他这句话;
        const isGroupTarget = target.type === 'group';
        const out = await llm.chat({
          system: `${composeSystemFor(isGroupTarget ? null : target.id, '', tone, isGroupTarget)}\n\n【现在的任务】${pcfg.prompt}`,
          // 同样要署名：主动开口时更容易把上文的某个人当成"当前对象"
          messages: sessions.toMessages(s.key, { label: isGroupTarget }).slice(-6),
        });
        let text = (out.text ?? '').trim();
        if (!text) continue;
        if (text.length > state.limits.maxReplyChars) {
          text = text.slice(0, state.limits.maxReplyChars) + '…';
        }

        const { segments, unknownTags } = splitReply(text, stickers);
        if (unknownTags.length) log.warn(`主动开口点了库里没有的表情：${unknownTags.join('、')}`);
        const styled =
          state.tone?.bratTilde === false
            ? segments
            : bratTildeSegments(segments, { bratty: tone.mayBrat || looksBratty(text) });
        const rich = buildRichSegments(styled, (p) => log.warn(`表情包文件读不到，已跳过：${p}`));
        if (rich.length === 0) rich.push({ type: 'text', text: stripImageMarkers(text) || '……' });
        const ok = await onebot.trySendRich(target, rich);
        if (!ok) continue;

        const plain = rich.filter((x) => x.type === 'text').map((x) => x.text).join(' ');
        sessions.recordAssistant(s.key, text);
        st.lastPingAt = now;
        st.count += 1;
        pingState.set(s.key, st);
        log.info(`[主动] ${s.key} 开口（${v.reason}）：${plain.slice(0, 100)}`);
        note({ scope: target.type, key: s.key, who: '小笛·主动', text: plain });
      } catch (err) {
        log.error(`主动开口失败 ${s.key}：${err.message}`);
      }
    }
  }

  /* ---------------- 提醒（真的会响的定时） ---------------- */
  /**
   * 为什么要有这一块：2026-10-07 主人说「你2分钟后提醒我写」，小笛回「现在开始计时」——
   * 而它当时**没有任何定时能力**，承诺直接落空（详见 `src/reminders.mjs` 开头）。
   * 教训还是那条：**凡是希望它一定会做的事，一律用代码兜。**
   */
  const reminders = new Reminders({
    // 路径走配置：**自测会把它指到临时文件**，免得跑一次自测就动到真实待提醒队列。
    file: resolve(ROOT, state.reminders?.file ?? 'logs/reminders.json'),
    log,
  });
  if (reminders.list.length) {
    log.info(`待提醒 ${reminders.list.length} 条：${reminders.list.map((r) => r.text).join('、')}`);
  }

  /* ---------------- 长期记忆（档案 + 日记 + 待审批草稿） ---------------- */
  /**
   * 为什么单独一块：小笛原本只有 6 小时过期的短期上下文，过夜就归零。
   * 记忆走**外部文件 + 代码写入**（模型只负责从对话里挑句子），规矩见 `src/memory.mjs` 开头。
   */
  const memory = new Memory({ ...state, memory: { ...(state.memory ?? {}), file: resolve(ROOT, state.memory?.file ?? 'logs/memory.json') } });
  log.info(
    `记忆：档案 ${memory.facts('10000000').length} 条（这条日志只是探活；真实条数按人分）` +
      `${state.memory?.enabled === false ? '（已关闭）' : ''}`,
  );

  /**
   * 把一段里的 **网图 URL** 换成"手里的图"：带 Referer 拉一次，成功即转 base64。
   * 拉不到的直接丢掉，并让调用方在文字里带一句实话。
   */
  async function localizeWebImages(segments) {
    const out = [];
    let dropped = 0;
    for (const seg of segments) {
      const src = seg?.type === 'image' ? String(seg.file ?? seg.url ?? '') : '';
      if (!/^https?:\/\//i.test(src)) {
        out.push(seg);
        continue;
      }
      try {
        const buf = await fetchImageBytes(src);
        out.push({ ...seg, file: `base64://${buf.toString('base64')}` });
      } catch {
        dropped += 1;
      }
    }
    return { segments: out, dropped };
  }

  /**
   * 搜图 → 自己下载 → 直接发。
   *
   * **「不重复」是这里的第一条规矩**（2026-10-07 用户报「你发的图一样」）：
   *   · 每一轮都从 `refs.sentKeys` 里排除发过的图 —— 判据是**归一化地址 + 内容 sha256**两层，
   *     只比地址会把"换个图床的同一张图"当成新图（实测踩过）；
   *   · 追问时**翻下一批候选**：Bing 的 `/images/search` 对同一个词永远返回同一批，
   *     所以要真的翻到 `/images/async?first=N`（`first` 只在 async 上有效，实测）。
   *   ⚠️ 上一版就栽在"记已发地址"写成了 `g.url`，而那个对象只有 `buf` —— 记进去全是 `undefined`，
   *      排除从未生效，于是「再来两张」把同一批图又发了一遍。**这个字段名以后别改回去。**
   *   · 这些记录都只在内存里（`refsFor` 有意如此）：重启后"发过哪些"和"上次搜的什么词"一起丢，
   *     所以重启后再问「再来两张」会回「我还不知道你要找什么的图」——**会退化成重新开始，不会错发**。
   */
  const IMAGE_WANT = 2; // 一次最多发几张
  const IMAGE_PAGE_SIZE = 12; // 一页取几个候选
  const IMAGE_PAGE_STEP = 35; // Bing 瀑布流翻页步长
  const IMAGE_MAX_PAGES = 2; // 一次最多翻几页（多翻一页约多花 1.5 秒）

  async function findAndSendImages(target, key, query, { tags = [], exclude = [] } = {}) {
    const refs = refsFor(key);
    // 换了搜索词就从头搜；同一个词接着问就往后翻（否则永远是同一批）
    if (String(refs.imageQuery ?? '') !== String(query)) {
      refs.imageQuery = String(query);
      refs.imageOffset = 1;
    }
    /**
     * ⚠️ **跨会话的"短时间内不重复"**（2026-10-09 用户要求）：会话级那份只记 80 个且重启就没，
     * 所以换个会话问同一句会把同一张图再发一遍。这里再并入一份**落盘 + 时间窗**的记录。
     */
    const blocked = new Set(refs.sentKeys ?? []);
    const windowMs = Math.max(1, Number(state.imageSearch?.repeatWindowHours ?? 24)) * 3600 * 1000;
    for (const k of recentSentKeys(SENT_IMAGE_FILE, { windowMs })) blocked.add(k);
    const got = [];
    let pages = 0;
    let candidates = 0;
    let alreadySeen = 0;
    let failed = 0;
    let offset = Math.max(1, Number(refs.imageOffset) || 1);
    const startedAt = offset;

    /**
     * **pixiv 优先**（2026-10-09 用户要求「搜图能不能上 pixiv 搜」）：
     * pixiv 的图画质/相关度明显好于普通网页搜索，所以先问它；拿不到（或代理没开）再走原来的 Bing。
     * ⚠️ pixiv 的图**必须带 Referer 下载**，所以这里给它单独的下载器（否则 i.pximg 返 403）。
     * 关掉：`imageSearch.pixiv: 'off'`。
     */
    /**
     * pixiv **只在主人的私聊里用**（2026-10-09 用户：「有点私心，还是想让它可以搜来发我自己的，
     * 群里要限制一下」）——群里一律走 Bing，避免把不适合群里的图发出去。
     */
    const pixivOk = pixivAllowedFor(target, state);
    /**
     * 分场景的"尺度"（2026-10-10 用户再次强调：「群里过滤 r-18，私聊也只能给主人发」）：
     * - **主人的私聊** → `safe:false`，什么都不过滤；
     * - **其它任何地方**（群、别人私聊）→ `safe:true`，走 pixiv 的 safe 档**并且**再按标签/字段兜一道。
     */
    const pixivSafe = !pixivOk;
    let pItemsForMeta = [];
    if (state.imageSearch?.pixiv !== 'off') {
      try {
        const tagged = await pixivSearchTagged({ keyword: query, tags, exclude, count: 20, safe: pixivSafe });
        const pItems = tagged.items;
        pItemsForMeta = pItems;
        if (exclude.length) {
          log.info(
            `[找图] 排除标签${exclude.map((t) => `【${t}】`).join('')} → 丢掉 ${tagged.excluded} 张，剩 ${pItems.length} 张`,
          );
        }
        if (tags.length) {
          const how = { all: '两个都有', tag: '退到第一个标签', any: '任一标签', none: '标签都没命中（用泛结果）' }[tagged.matched] ?? tagged.matched;
          /**
           * ⚠️ 2026-10-10 下午：标签在 pixiv 上要**换写法**（中文题材词 → 日文通用标签，见 `src/pixiv-tags.mjs`）。
           * 日志里把这一步显出来（`【颜射→顔射】`），否则"我明明说了颜射，怎么搜的别的词"没法对账。
           */
          const shown = tags
            .map((t) => {
              const s = searchTagFor(t);
              return s && s !== t ? `【${t}→${s}】` : `【${t}】`;
            })
            .join('');
          log.info(`[找图] 标签${shown} → ${how}（搜索词：「${tagged.usedWord}」），${pItems.length} 条`);
        }
        if (pixivSafe && tagged.dropped) log.info(`[找图] ${pixivOk ? '' : '非主人私聊 → '}已过滤 R-18 类 ${tagged.dropped} 张`);
        /**
         * ⚠️ **pixiv 一条都没拿到时必须出声**（2026-10-14 加）。
         *
         * 起因：用户报「搜图他不优先 pixiv」✗ —— 查 09:45 的日志只看到
         * 「标签【白丝】 → 标签都没命中（用泛结果），**0 条**」✗，**紧接着就悄悄退到 Bing** ✗，
         * 捞回「汉字'白'的书法教学图」这种垃圾 ✓。而**"为什么 0 条"一个字都没记** ✗
         * （接口变了？代理抖了？关键词真没结果？查不出来 ✗）—— 于是这个问题藏了好几天 ✓。
         * 现在：0 条就明确写一行，把"失败"和"真没结果"分开 ✓。
         */
        if (!pItems.length) {
          log.warn('[找图] pixiv 这条线**一条都没拿到**（接口变了 / 代理抖了 / 关键词没结果，三种都可能）→ 这次退到网页搜索 ✗');
        }
        if (pItems.length) {
          const pr = await collectFreshImages(
            // 标签/分级一起带上：发前筛图那道闸要拿它当"事实"（2026-10-10）。
            pItems.map((x) => ({ url: x.url, page: x.pageUrl, title: x.title, tags: x.tags, xRestrict: x.xRestrict })),
            { seen: blocked, want: IMAGE_WANT - got.length, batchSize: 4, maxTry: 8, fetchBytes: fetchPixivImage },
          );
          got.push(...pr.got);
          alreadySeen += pr.alreadySeen;
          failed += pr.failed;
          candidates += pItems.length;
          log.info(`[找图] pixiv 源：「${query}」${pItems.length} 个候选 → 拿到 ${pr.got.length} 张（跳过发过的 ${pr.alreadySeen}）`);
        }
      } catch (err) {
        log.warn(`[找图] pixiv 源不可用（代理没开？）：${err.message}`);
      }
    } else if (state.imageSearch?.pixiv !== 'off') {
      log.info('[找图] pixiv 关掉了（imageSearch.pixiv=off）→ 只用 Bing');
    }

    while (got.length < IMAGE_WANT && pages < IMAGE_MAX_PAGES) {
      const items = await searchImageUrls(query, IMAGE_PAGE_SIZE, { offset });
      pages += 1;
      offset += IMAGE_PAGE_STEP;
      if (!items.length) break;
      candidates += items.length;
      const r = await collectFreshImages(items, {
        seen: blocked,
        want: IMAGE_WANT - got.length,
        batchSize: 4,
        maxTry: 8,
      });
      got.push(...r.got);
      alreadySeen += r.alreadySeen;
      failed += r.failed;
    }
    refs.imageOffset = offset;

    if (!got.length) {
      if (candidates && alreadySeen >= candidates) {
        return `这个「${query}」我翻了 ${pages} 页、拿到 ${candidates} 个候选，**全是之前发过的** —— 换个说法（比如加个「壁纸」「同人」）我再找。`;
      }
      if (candidates) {
        return `翻了 ${pages} 页共 ${candidates} 个候选，**一张都下载不下来**（都带防盗链）。我不给你贴打不开的链接 —— 换个说法或换个名字再试。`;
      }
      return `没搜到「${query}」的图。`;
    }

    let sentCount = 0;
    const sentParts = [];
    let screenedOut = 0;
    /** ⚠️ 原来 `if (!ok) continue;` **没有计数** —— 于是"发送失败"和"被筛掉"在下面那句文案里混成一团。 */
    let sendFailed = 0;
    let excludedOut = 0;
    const sentNow = [];
    /**
     * **发出去了就报作者和作品号**（2026-10-10 用户要求）。
     * pixiv 的候选里带 author/id，按 url 建索引对回来即可（Bing 来的没有，就不报）。
     */
    const metaByUrl = new Map();
    for (const it of pItemsForMeta) if (it?.url) metaByUrl.set(it.url, it);
    const sentMeta = [];
    /**
     * ⚠️ **排除标签在这里再兜一道**（2026-10-10 17:0x 用户要求「不要的就别发」）：
     * `got` 里的候选带着**自己的标签与分级**（本轮上午刚补上的），所以这里能拦住
     * pixiv 之外那条路（Bing 来的没有标签 → 拦不住，交给筛图闸的 `exclude` 话术）。
     */
    const afterExclude = filterExcluded(got, exclude);
    excludedOut = afterExclude.dropped;
    for (const g of afterExclude.kept) {
      /**
       * ⚠️ **发之前先筛一遍**（2026-10-09 用户要求：「识图先筛一遍，别啥都往外发」）：
       * 让视觉模型看一眼「这张能不能当『<搜索词>』的结果发出去」，只放行说"合适"的。
       * 筛图**失败时放行**（宁可偶尔发一张不合适的，也不要因为接口抽风就一张都发不出），但会记日志。
       *
       * ⚠️ **场景必须传进去**（2026-10-10 用户报的第二个问题）：`pixivOk` 就是
       * 「这是主人的私聊」那个判据 —— 私聊里 R-18 是允许的，不能因为露骨就否决。
       * ⚠️ 用户明确说了不要的标签（`exclude`）也要传进去 —— Bing 来的图没有标签可比，
       * 只能让"看图的"来判（例：「不要 r18」时，露骨的直接判不合适）。
       */
      const pass = await screenImageForSend(state, g, query, { log, allowR18: pixivOk, exclude });
      if (!pass) {
        screenedOut += 1;
        continue;
      }
      const ok = await onebot.trySendRich(target, [{ type: 'image', file: `base64://${g.buf.toString('base64')}` }]);
      if (!ok) {
        sendFailed += 1;
        continue;
      }
      sentCount += 1;
      sentParts.push(g.sha.slice(0, 8));
      // ⚠️ 只把**真的发出去**的图记成"发过的"（发失败的下次还能再试）
      refs.sentKeys = [...(refs.sentKeys ?? []), ...g.keys].slice(-80);
      sentNow.push(...g.keys); // 跨会话时间窗去重用（见下面 rememberSentImages）
      {
        const meta = metaByUrl.get(g.url);
        if (meta?.id) sentMeta.push(`作品 ${meta.id}（${meta.author || '佚名'}）${meta.title ? `：${meta.title}` : ''}`);
      }
    }
    if (sentNow.length) {
      const total = rememberSentImages(SENT_IMAGE_FILE, sentNow, { windowMs });
      log.info(`[找图] 已记入"近期发过的图"（窗口内共 ${total} 个身份键，${Math.round(windowMs / 3600000)} 小时内不再发）`);
    }
    log.info(
      `[找图] 「${query}」first=${startedAt} 起、翻 ${pages} 页 / ${candidates} 个候选 → ` +
        `发出 ${sentCount} 张（sha ${sentParts.join(',') || '无'}）；跳过发过的 ${alreadySeen}、筛掉 ${screenedOut}、` +
        `排除标签丢掉 ${excludedOut}、发送失败 ${sendFailed}、下载失败 ${failed}`,
    );
    /**
     * ⚠️ **2026-10-10 17:0x 修一条会冤枉 NapCat 的文案**（日志实证 08:55）：
     * 那次"找到 2 张、发出 0 张"其实是**两张都被筛图闸筛掉了**（理由「与八重神子无关」），
     * 而这里一律写「**一张都没发出去（NapCat 那边失败了）**」→ 用户和下一个我都去查 NapCat ✗。
     * 判据（`memory/lessons.md`）：**别把"我这儿没发"说成"平台发不出去"**。
     * 文案本身抽成了纯函数 `describeNoSend()`，这样能被自测钉住。
     */
    if (!sentCount) {
      return describeNoSend({
        query,
        found: got.length,
        kept: afterExclude.kept.length,
        screenedOut,
        sendFailed,
        excludedOut,
        exclude,
      });
    }

    const metaLine = sentMeta.length ? `\n出处：\n${sentMeta.map((x) => `· ${x}`).join('\n')}` : '';
    await say(target, key, `（找到并发出 ${sentCount} 张「${query}」的网图）${metaLine}`, '小笛·找图');
    return (
      `发出 **${sentCount} 张**（翻了 ${pages} 页 / ${candidates} 个候选；` +
      `跳过 ${alreadySeen} 张发过的，${failed} 张下载失败）。` +
      `**这几张跟之前发的绝不重复**，别说成"存货不多了"。` +
      (sentMeta.length ? `\n**顺便把她/他的出处报给用户**（别省略）：\n${sentMeta.map((x) => `· ${x}`).join('\n')}` : '')
    );
  }

  /** 主动发一条 + **写进它自己的上下文**（规矩：机器人主动说的话也要留痕）。 */
  async function say(target, key, text, who = '小笛·主动') {
    const ok = await onebot.trySend(target, text);
    if (ok) {
      sessions.recordAssistant(key, text);
      note({ scope: target.type, key, who, text });
    }
    return ok;
  }

  /**
   * 整理一次长期记忆：**代码触发、模型只提取、产出草稿等他审**。
   * 不自动落盘 —— 他说了才算（错事实一旦进档案会污染之后每一次对话）。
   */
  async function consolidate(key, userId, target) {
    const turns = sessions.history(key);
    /**
     * ⚠️ 游标记的是「第几条」，而会话历史**有上限**（`limits.historyTurns` 50 轮 ≈ 100 条）。
     * 2026-10-07 实测翻车：`cursor` 顶到 100 之后，`slice(100)` **永远是空** ——
     * 「整理记忆」从此永久回「太少了，晚点再说」，攒再多也没用。
     * 所以这里把游标**夹**在「长度 − 40」以内：任何情况下都留下最近约 20 轮可整理。
     * 重复整理是安全的：同一条事实不会重复记（`addFact` 里有判据），草稿还要主人审。
     */
    const from = Math.min(memory.cursor(key), Math.max(0, turns.length - 40));
    const fresh = turns.slice(from);
    /**
     * ⚠️ **窗口没变就别再挖一遍**（2026-10-09 用户要求"bug 修彻底"）：
     * 上面那个 `Math.min` 会把游标夹在"倒数第 40 条"，于是它**每次都看同一批 40 条** ——
     * 实测五次日志全是"新对话 40 条"、草稿大量重叠；而**每挖一次都可能新造一批错事实**
     * （12:30 那三条假事实就是这么来的）。指纹一样 = 没有新对话，直接跳过。
     */
    const tailMark = `${fresh.length}#${String(fresh[fresh.length - 1]?.content ?? '').slice(0, 80)}`;
    if (memory.tailMark(userId) === tailMark) {
      log.info(`[记忆] 没整理成：这一批对话上次已经整理过了（${fresh.length} 条，指纹未变）`);
      return { ok: false, why: '这一批对话上次已经整理过了，等有新对话再整理' };
    }
    if (fresh.length < 4) {
      log.info(`[记忆] 没整理成：能整理的新对话只有 ${fresh.length} 条（游标 ${memory.cursor(key)} / 历史 ${turns.length}）`);
      return { ok: false, why: `能整理的新对话只有 ${fresh.length} 条，太少了，晚点再说` };
    }
    const source = fresh.map((t) => t.content).join('\n');
    const date = localDay();
    const ask = buildConsolidationAsk({ turns: fresh, existing: memory.facts(userId), date });
    let out;
    try {
      out = await llm.chat({ system: '你只做事实提取，严格按给定格式输出。', messages: [{ role: 'user', content: ask }] });
    } catch (err) {
      log.warn(`[记忆] 没整理成：提取那一步失败 —— ${err.message}`);
      return { ok: false, why: `提取那一步失败了：${err.message}` };
    }
    const items = draftFrom({ rawText: out?.text ?? '', turns: fresh, existing: memory.facts(userId), date, source });
    if (!items.length) {
      log.info(`[记忆] 没整理成：看了 ${fresh.length} 条对话，没挑出值得记的`);
      return { ok: false, why: '这一轮没整理出值得记的东西（可能都是闲聊）' };
    }
    memory.setDraft(userId, items);
    memory.setCursor(key, turns.length); // 这些对话算整理过了，别重复提
    memory.setTailMark(userId, tailMark); // 指纹：窗口没变就不再挖（见上面那段说明）
    const sent = await say(target, key, formatDraft(items), '小笛·记忆草稿');
    if (!sent) {
      log.warn('[记忆] 草稿没发出去（OneBot 可能掉了），先不记');
      return { ok: false, why: '草稿没发出去（OneBot 可能掉了），先不记' };
    }
    log.info(`[记忆] 草稿已发（${items.length} 条）：${items.map((i) => i.text).join(' / ').slice(0, 120)}`);
    return { ok: true, count: items.length };
  }

  async function fireDueReminders() {
    const now = Date.now();
    for (const r of reminders.due(now)) {
      const target = { type: 'private', id: String(r.userId) };
      const when = new Date(r.dueAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const late = now - r.dueAt > 90 * 1000;
      const text = late
        ? `提醒你：${r.text}\n（这条本该 ${when} 提醒你，晚了 ${humanizeGap(now - r.dueAt)} —— 中间我大概重启过。）`
        : `提醒你：${r.text}`;
      const ok = await onebot.trySend(target, text);
      if (ok) {
        log.info(`[提醒] 已提醒 ${r.userId}：${r.text}`);
        /**
         * ⚠️ **必须写进会话上下文**，不能只喂面板的 recent。
         * 2026-10-07 的翻车就是这里少了一行：提醒**真的发出去**了（15:10:03），
         * 但模型上下文里没有这回事 —— 于是主人 15:10:13 回「来了」时，
         * 它答「十五点十分我喊你哈，还有一会儿呢」（当场自相矛盾，正是用户报的
         * 「定时任务和上下文不连贯」）。面板 recent 里有、sessions.json 里没有，
         * 就是这一处的指纹。
         * 规矩和「主动开口」那条一样：**机器人自己主动说的话，也要留在它自己的上下文里**。
         */
        sessions.recordAssistant(`private:${r.userId}`, text);
        note({ scope: 'private', key: `private:${r.userId}`, who: '小笛·提醒', text });
        reminders.markFired(r.id, now);
      } else {
        // 发不出去就先留着（OneBot 掉线是常事），但别无限重试
        r.attempts = (r.attempts ?? 0) + 1;
        log.warn(`[提醒] 第 ${r.attempts} 次没发出去，先留着：${r.text}`);
        if (r.attempts >= 5) {
          log.error(`[提醒] 试了 5 次都发不出去，丢掉：${r.text}`);
          reminders.markFired(r.id, now);
        } else {
          reminders.save();
        }
      }
    }
  }

  /**
   * **它自己整理记忆**（2026-10-07 用户要求：「让他自己整理记忆」）。
   * 仍然守两条老规矩：① 只提取、不落盘 —— 草稿**发主人审**；② 不打搅：白天、攒够量、有冷却。
   * 为什么不让模型"觉得该记就记"：它会为了顺着话头而记一堆废话（甚至编），所以触发条件放代码里。
   */
  async function autoConsolidate() {
    if (state.memory?.enabled === false) return;
    const cfgM = state.memory ?? {};
    const hour = new Date().getHours();
    if (hour < Number(cfgM.autoHourFrom ?? 9) || hour >= Number(cfgM.autoHourTo ?? 23)) return;
    const minFresh = Number(cfgM.autoMinFresh ?? 8);
    const cooldown = Number(cfgM.autoCooldownHours ?? 6) * 3600000;
    const now = Date.now();
    for (const key of refsByKey.keys()) { // Sessions 只暴露 history/record，没有遍历接口；用这个现成的键表
      if (!key.startsWith('private:')) continue; // 只在私聊里整理（群里人多，不该替所有人攒）
      const userId = key.slice('private:'.length);
      const master = (state.master?.users ?? []).map(String).includes(userId);
      if (!master) continue;
      const turns = sessions.history(key);
      const from = Math.min(memory.cursor(key), Math.max(0, turns.length - 40));
      const fresh = turns.length - from;
      const lastAt = Number(memory.data.auto?.[key] ?? 0);
      if (fresh < minFresh) { log.debug?.(`[记忆] 自动整理跳过：新对话 ${fresh} < ${minFresh}`); continue; }
      if (now - lastAt < cooldown) continue;
      memory.data.auto = memory.data.auto ?? {};
      memory.data.auto[key] = now;
      memory.save();
      try {
        const r = await consolidate(key, userId, { type: 'private', id: userId });
        log.info(`[记忆] 自动整理：${r.ok ? `草稿已发（${r.count} 条）` : `没成 —— ${r.why}`}（新对话 ${fresh} 条）`);
      } catch (err) {
        log.warn(`[记忆] 自动整理出错：${err.message}`);
      }
    }
  }

  /* ---------------- 自己冲浪（随机间隔 / 无聊了） ---------------- */
  let lastHumanAt = Date.now(); // 主人上次说话的时间（handle 里更新）

  async function surfOnce() {
    const c = state.surf ?? {};
    // ⚠️ 2026-10-18：**不要再取 `state.master.users[0]`** ✗ —— 那是 QQ 时代的主人号（10000000），
    //    在 Telegram 上拿它当 chat_id 就是 `Bad Request: chat not found` ✓（日志里 89 条就是它 ✓）。
    //    统一走 masterTargetOf()：它按**当前传输层**给目标（TG → telegram.masterUserId ✓）。
    const mt = masterTargetOf(state);
    if (!mt) return;
    const { key, target } = mt;
    const master = mt.id;
    const sf = (memory.data.surf ??= { sent: [], sentDay: '', sentToday: 0 });
    const today = new Date().toDateString();
    if (sf.sentDay !== today) { sf.sentDay = today; sf.sentToday = 0; }
    const verdict = shouldSurf({
      cfg: c, now: Date.now(), lastSurfAt: sf.lastAt ?? 0, lastHumanAt, sentToday: sf.sentToday ?? 0,
    });
    log.info(`[冲浪] ${verdict.go ? '去' : '不去'}：${verdict.why}`);
    if (!verdict.go) return;

    // 素材：**走结构化接口**，不再靠"解析工具返回的人话"取数据。
    // 2026-10-08 修掉两处接错（原来每 10 分钟只打一句"取材失败"）：
    //   ① `hotBilibili()` 的文本里**没有链接**（只有标题/UP/播放量）→ `parseSearchLines()` 抠不到 URL
    //      → B站源永远产出 0 条；改用 `hotBilibiliList()`（同一份 JSON，结构化）。
    //   ② 这里原来传的是 `ctxBase`，而它是**消息处理函数里的局部变量** → 引用必然 ReferenceError
    //      （被下面的 catch 吞掉，看起来只是"没取到"）。`web_search` 是只读工具，根本不需要 ctx。
    let items = [];
    try { items.push(...(await hotBilibiliList({ count: 12 }))); } catch (err) { log.warn(`[冲浪] B站热门没取到：${err.message}`); }
    /**
     * ⚠️ **查询词不再写死**（2026-10-12，用户问「为什么卡新闻了」）：
     * 原来永远是 `'今日热点新闻'` ⇒ 搜索回来一堆新闻站（头条/网易/央视/新浪/人民网），
     * 于是她隔一会儿就发一条新闻。现在从配置的一组词里**轮换**（默认掺了"有趣/新奇"这类）。
     */
    const surfQuery = pickQuery(c.surf?.queries, Date.now());
    try {
      items.push(...parseSearchLines(String(await execTool('web_search', { query: surfQuery, count: 8 }))));
      log.info(`[冲浪] 搜索词：${surfQuery}`);
    } catch (err) { log.warn(`[冲浪] 网络搜索没取到：${err.message}`); }
    /**
     * ⚠️ **新闻站降权**（同一天）：视频要过"看懂"那道审、**新闻不用** ⇒ 新闻几乎必发。
     * 把新闻域名排到后面，让 `pickFresh()` 先拿视频/别的来源（没有别的可发时才轮到新闻）。
     */
    items = orderItems(items, { avoidDomains: c.surf?.avoidDomains ?? [] });
    if (!items.length) { log.warn('[冲浪] 两个源都没取到东西，这次跳过'); return; }
    // ⚠️ 取材要**看得见**（2026-10-09）：空标题的空壳会让它对着空气编（"黄历"就是这么来的），
    //    所以把"总共几条 / 可用几条"打进日志；没选到也要说清楚是"没新的"还是"全是空壳"。
    const usableCount = (items ?? []).filter(isUsableItem).length;
    log.info(`[冲浪] 取材：共 ${items.length} 条，可用 ${usableCount} 条`);
    const fresh = pickFresh(items, sf.sent ?? []);
    if (!fresh) {
      log.info(`[冲浪] 没有能用的新素材（共 ${items.length} 条，可用 ${usableCount} 条）—— 这次跳过`);
      return;
    }

    // **看懂**再决定发不发：B站候选优先走"抓字幕 → 它读一遍 → 判断值不值得发"。
    // 判断主体放在字幕上（视频里说的话）；画面只有封面能高清，雪碧图每格才 160×90（见 src/watch.mjs 开头）。
    let line = '';
    let coverUrl = '';
    let bvid = '';
    const taste = memory
      .facts(master)
      .filter((f) => f.who !== 'self')
      .map((f) => f.text)
      .slice(0, 12)
      .join('；')
      .slice(0, 400);
    bvid = parseBvid(String(fresh.url ?? '')) ?? parseBvid(String(fresh.title ?? '')) ?? '';
    if (bvid) {
      try {
        // ⚠️ 必须用 `videoInfoRaw()`（返回对象）—— `videoInfo()` 返回的是**字符串**，
        // 取 `info.cid` 永远是 undefined，字幕那一步根本不会发生（2026-10-08 交接里的头号坑）。
        const info = await videoInfoRaw({ bvid });
        const cid = info?.cid ?? null;
        const rawSub = cid ? await getSubtitle(bvid, cid, { maxLines: 400 }) : null;
        const subLines = Array.isArray(rawSub) ? rawSub : String(rawSub ?? '').split('\n');
        const subtitle = trimSubtitle(subLines, 200);
        const ask = buildJudgeAsk({
          title: info?.title ?? fresh.title ?? '',
          up: info?.up ?? '',
          desc: info?.desc ?? '',
          subtitle,
          taste,
        });
        const verdictOut = await llm.chat({ system: state.llm.system, messages: [{ role: 'user', content: ask }] });
        const verdict = parseJudge(verdictOut?.text ?? '');
        // 日志要把**关键中间量**写出来：cid 有没有、字幕几句 —— 否则"空转"在日志上看不出来
        // （交接里的教训：日志要盯数量，不是只盯"内容出现过"）。
        log.info(
          `[冲浪] 看懂「${String(info?.title ?? bvid).slice(0, 30)}」（cid=${cid ? '有' : '**没有**'}，` +
            `字幕 ${subLines.filter(Boolean).length} 句）→ ${verdict.send ? '值得发' : '跳过'}：${verdict.why.slice(0, 40)}`,
        );
        if (!verdict.send) {
          sf.sent = [...(sf.sent ?? []), itemKey(fresh), String(fresh.url ?? '')].filter(Boolean).slice(-80);
          memory.save();
          return;
        }
        coverUrl = bigCover(info?.pic ?? '', 1920, 1080);
        line = `${verdict.why || '这个我觉得你会喜欢'}\n【${String(info?.title ?? '').slice(0, 60)}】https://www.bilibili.com/video/${bvid}`;
      } catch (err) {
        log.warn(`[冲浪] 看懂这一步失败（退回只发标题）：${err.message}`);
      }
    }
    if (!line) {
      // 不是 B站、或者看懂失败：退回"用自己的语气说一句"
      try {
        const out = await llm.chat({
          system: state.llm.system,
          messages: [{ role: 'user', content: `你刚在网上看到这个：${fresh.title ?? ''}${fresh.url ? `（${fresh.url}）` : ''}。\n用你自己的语气（元气、可以俏皮）两三句说给主人听，像"我刚刷到…"那样。别提"搜索""工具"这类词，也别问他要不要看。` }],
        });
        line = String(out?.text ?? '').trim();
      } catch (err) { log.warn(`[冲浪] 写话失败：${err.message}`); return; }
    }
    // 高清封面（能拿到就带上，发不出去不影响文字）
    if (coverUrl) {
      try { const buf = await fetchImageBytes(coverUrl); await onebot.trySendRich(target, [{ type: 'image', file: `base64://${buf.toString('base64')}` }]); } catch (err) { log.warn(`[冲浪] 封面没发出去：${err.message}`); }
    }
    if (!line) return;

    const ok = await say(target, key, line, '小笛·冲浪');
    if (!ok) { log.warn('[冲浪] 没发出去'); return; }
    sf.lastAt = Date.now();
    sf.nextGapMs = surfGapMs(c);
    sf.sent = [...(sf.sent ?? []), itemKey(fresh), String(fresh.url ?? '')].filter(Boolean).slice(-80);
    sf.sentToday = (sf.sentToday ?? 0) + 1;
    // ⚠️ 2026-10-09 用户报「记忆记得有问题」：`fresh.title` 可能为空，
    //    于是日记写成「自己刷到「」，跟主人说了」（废条目）—— 这也解释了它那阵子老拿"黄历"填空白。
    //    有标题才写日记；没有就记一行 warn（顺带暴露"冲浪素材没标题"这个上游问题）。
    const surfLabel = String(fresh.title ?? '').trim();
    if (surfLabel) memory.writeDiary(master, undefined, `自己刷到「${surfLabel}」，跟主人说了。`);
    else log.warn(`[冲浪] 素材没有标题（${String(fresh.url ?? fresh.bvid ?? '?').slice(0, 60)}）—— 日记跳过，不写空条目`);
    memory.save();
    log.info(`[冲浪] 已发：${String(fresh.title ?? '').slice(0, 40)}`);
  }

  const surfTimer = setInterval(() => {
    surfOnce().catch((err) => log.warn(`[冲浪] 出错：${err.message}`));
  }, Math.max(60000, Number(state.surf?.checkEveryMinutes ?? 10) * 60000));
  surfTimer.unref?.();

  // ⚠️ 2026-10-19：用户要求「玩的时候发我消息，我批了就去玩」⇒ **撤掉自动定时** ✓（她自己问、他点头才玩）。


  const autoMemoryTimer = setInterval(() => {
    autoConsolidate().catch((err) => log.warn(`[记忆] 自动整理定时器出错：${err.message}`));
  }, Math.max(60000, Number(state.memory?.autoEveryMinutes ?? 30) * 60000));
  autoMemoryTimer.unref?.();

  const reminderTimer = setInterval(() => {
    fireDueReminders().catch((err) => log.error(`提醒出错：${err.message}`));
  }, 20 * 1000);
  reminderTimer.unref?.();
  // 启动 3 秒后补一次：重启期间到点的提醒不该被静默吃掉
  const catchUp = setTimeout(() => fireDueReminders().catch(() => {}), 3000);
  catchUp.unref?.();

  /* ---------------- 审批通知转发（只通知，**绝不代替你点**） ---------------- */
  /**
   * 主人不一定坐在机器前。这里有且只有一件事：把「有个审批在等你」发到他私聊。
   * 至于"同意"这个动作**必须回到机器上点** —— 为什么不做远程点同意，
   * 见 `src/approvals.mjs` 开头的三条理由（简单说：那等于给这台机器开一个 QQ 提权入口）。
   */
  const approvals = new ApprovalWatcher({
    // 空 = 默认 ~/.dsh/sessions；自测会把它指到临时目录
    ...(state.approvals?.sessionsDir ? { dir: resolve(ROOT, state.approvals.sessionsDir) } : {}),
    log,
  });

  async function relayApprovals() {
    if (state.approvals?.enabled === false) return [];
    // ⚠️ 2026-10-18：这里原来写 `state.master.users[0]` ✗ —— 那是 QQ 号，
    //    在 Telegram 上发审批通知就是 `chat not found` ✓（和 surfOnce 同一个错 ✓）。统一走 masterTargetOf ✓。
    const mt = masterTargetOf(state);
    const master = mt ? mt.id : "";
    if (!master) return []; // 没配主人名单 → 没人可发（面板上不填就不发，不是错误）
    const pending = approvals.poll();
    for (const a of pending) {
      const ok = await onebot.trySend(mt.target, formatApproval(a));
      if (ok) {
        log.info(`[审批] 已转发给主人：${a.toolName}（${a.session}）`);
        /**
         * 和提醒同一条规矩：**机器人自己主动发出去的话，也要留在它自己的上下文里。**
         * 否则主人回一句「收到了 / 同意了」，模型完全不知道在说什么（会答成"收到什么？"）。
         * 提醒那处漏了这一行，当天就翻了车；审批这处是同一个形状，一并补上。
         */
        sessions.recordAssistant(mt.key, formatApproval(a));
      } else {
        approvals.forget(a.id); // 发失败就放回队列，下一轮重报
        log.warn(`[审批] 转发失败，留着重试：${a.toolName}`);
      }
    }
    return pending;
  }

  const approvalTimer = setInterval(() => {
    relayApprovals().catch((err) => log.error(`审批转发出错：${err.message}`));
  }, Math.max(5000, Number(state.approvals?.pollMs) || 15000));
  approvalTimer.unref?.();

  const pinger = setInterval(() => {
    let force = false;
    try {
      if (existsSync(PING_NOW_FILE)) {
        rmSync(PING_NOW_FILE, { force: true });
        force = true;
      }
    } catch {
      /* 忽略 */
    }
    runProactive({ force }).catch((err) => log.error(`主动开口出错：${err.message}`));
  }, 60 * 1000);
  pinger.unref?.();

  /**
 * ⚠️ **连接失败不能静默**（2026-10-14 修 ✗）：原来是光秃秃一句 `onebot.connect();` ✓，
 * 而 `Telegram.connect()` 是 **async** ✓ ⇒ 它抛错就变成"没人接的 Promise" ✗ ⇒
 * **日志里一个字都没有、传输层却已经废了** ✓✓（今晚用户重启后就撞上这个：一条 `[tg]` 都没有 ✓）。
 * OneBot 的 `connect()` 是**同步**的 ✓ ⇒ 这里先判返回值是不是 Promise 再挂 catch ✓（两边都安全 ✓）。
 */
const connectResult = onebot.connect();
if (connectResult && typeof connectResult.catch === 'function') {
  connectResult.catch((err) => log.error(`传输层连接失败（${state.transport}）：${err.message}`));
}
  writeStatus();

  return {
    onebot,
    llm,
    sessions,
    router,
    reminders,
    approvals,
    reload,
    runProactive,
    fireDueReminders,
    relayApprovals,
    get stickers() {
      return stickers;
    },
    get systemPrompt() {
      return systemPrompt;
    },
    stop() {
      clearInterval(sweeper);
      clearInterval(heartbeat);
      clearInterval(pinger);
      clearInterval(reminderTimer);
      clearInterval(approvalTimer);
      clearTimeout(catchUp);
      unwatchFile(CONFIG_FILE);
      onebot.close();
      if (status) {
        try {
          rmSync(STATUS_FILE, { force: true });
        } catch {
          /* 忽略 */
        }
      }
    },
  };
}

/* ------------------------------ CLI ------------------------------ */

function printCheck(config, source) {
  const lines = [
    `配置文件：${source ?? '（用内置默认值）'}`,
    `OneBot  : ${config.onebot.url}${config.onebot.token ? '（带 token）' : '（无 token）'}`,
    `模型    : ${describeBackend(config)}`,
    `私聊    : ${config.trigger.private}   群聊: ${config.trigger.group}`,
    `白名单  : 私聊 ${config.whitelist.users.length ? config.whitelist.users.join(',') : '不限制'}   群 ${config.whitelist.groups.length ? config.whitelist.groups.join(',') : '不限制'}`,
    `冷却    : ${config.limits.cooldownMs}ms   上下文: ${config.limits.historyTurns} 轮`,
  ];
  console.log(lines.join('\n'));
}

async function main() {
  const argv = process.argv.slice(2);
  const { config, source } = loadConfig();
  const log = createLogger();

  if (argv.includes('--check')) {
    printCheck(config, source);
    console.log('模型连通性：检查中…');
    const llm = createLLM(config, { log, maxAttempts: 1 });
    const r = await llm.healthCheck();
    console.log(`模型连通性：${r.ok ? '✅ 通' : '❌ 不通'} — ${r.detail}`);
    process.exit(r.ok ? 0 : 1);
  }

  if (argv.includes('--test-llm')) {
    const text = argv.filter((a) => !a.startsWith('--')).join(' ') || '你好，用一句话介绍你自己';
    const llm = createLLM(config, { log, maxAttempts: 1 });
    const r = await llm.chat({ messages: [{ role: 'user', content: text }] });
    console.log(`\n[${r.provider}/${r.model}] ${r.text}\n`);
    return;
  }

  printCheck(config, source);

  const lock = acquireLock();
  if (!lock.ok) {
    const h = lock.holder;
    console.error(
      [
        '',
        `❌ 已经有一个机器人实例在跑了：PID ${h.pid}，启动于 ${new Date(h.startedAt).toLocaleString()}`,
        '   同时跑多个实例会让同一条消息被回复多次。',
        '',
        '   先停掉它（注意：DSH 的 job_kill 不会杀掉 node 子进程，必须按 PID 停）：',
        `     Stop-Process -Id ${h.pid} -Force`,
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  const bot = startBot(config, { log });
  log.info(`机器人已启动（PID ${process.pid}），日志文件：${log.file}`);
  log.info('配置热重载已开启：改 config.json（或用控制面板）即时生效，不用重启');
  /**
   * ⚠️ **代理状态必须自证**（2026-10-19 加）。
   * 用户报过「代理明明是正常的，为什么 getUpdates 一直 fetch failed」✓ ——
   * 真因是**这个进程没拿到代理变量** ✗（启动时序：先开机器人、后开代理 ⇒ 脚本当时没设变量 ✓）。
   * 以后再遇到，看这一行就知道是"网络不行"还是"这个进程没代理" ✓。
   */
  const _px = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  log.info(_px ? `代理：${_px}（进程已拿到 ✓）` : '代理：**没设** —— 这个进程是**直连** ✗（先开代理再重启机器人）');
  const shutdown = () => {
    log.info('正在关闭…');
    bot.stop();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`启动失败：${err.stack ?? err.message}`);
    process.exit(1);
  });
}






