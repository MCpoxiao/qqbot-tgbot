/**
 * **本地语音合成**（2026-10-14 用户要求「语音发送要做」）。
 *
 * 路线：**Windows SAPI（离线、免费、无需 key）→ WAV → ffmpeg → OGG/Opus** ✓
 * —— Telegram 的语音消息（`sendVoice`）**必须是 ogg/opus** ✓，所以中间那步不能省 ✓。
 *
 * 为什么不用云 TTS ✗：要 key、要钱、要联网（而且语音是"她想说句话"这种小场景 ✓）。
 * 本机实测有 **4 个中文嗓子** ✓：Huihui Desktop / Huihui / Kangkang(男) / **Yaoyao** ✓。
 *
 * ## 两个必须记住的工程细节
 * 1. **文本走临时文件，不进命令行** ✗：中文 + 标点 + 引号塞进 pwsh 命令行是灾难 ✓
 *    （这个项目今天已经因为引号栽了好几次 ✗）。写进 `in.txt`，让 PowerShell 读文件 ✓。
 * 2. **不要用管道**（`child_process` 的默认 `stdio: 'pipe'`）：本机沙箱里会 **EPERM** ✗，
 *    而且生产环境也没必要 ✓。全程用**文件进、文件出** ✓，日志自己打 ✓。
 *
 * ## 说话前要先"洗一遍文本"
 * 她的话里常有 `（尾巴晃了晃）` 这种**动作描写** ✓ 和 emoji ✓ ——
 * 念出来会很怪 ✗（"左括号尾巴晃了晃右括号" ✓）。所以：
 * 括注（中英文括号都算）、emoji、markdown 记号、CQ 码**全部去掉** ✓；
 * 太长的话**截断**（语音消息别超过一分钟 ✓）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveFfmpeg } from './video.mjs';
import { tmpdir } from 'node:os';

/** 默认嗓子：**Yaoyao**（女声，实测这台机器上有 ✓）。可被 `config.voice.voice` 覆盖。 */
export const DEFAULT_VOICE = 'Microsoft Yaoyao';

/** 语速：SAPI 的 -10..10 ✓。小笛说话稍快一点更像年轻人 ✓。 */
const DEFAULT_RATE = 2;

/** 太长就别念了（语音消息超过一分钟很烦 ✓）—— 超了就截断 ✓。 */
const MAX_SPEECH_CHARS = 180;

/**
 * **把回复文本洗成"能念的句子"**（纯函数 ✓，自测直接钉 ✓）。
 * - 去掉括注（`（）`/`()`/`【】` 的内容 ✓）—— 那是动作描写，不是台词 ✗；
 * - 去掉 emoji / 颜文字 / markdown 记号 ✓；
 * - 去掉 CQ 码与 URL ✓；
 * - 折叠空白 ✓，超长截断 ✓。
 */
export function cleanSpeechText(text, { maxChars = MAX_SPEECH_CHARS } = {}) {
  let s = String(text ?? '');
  if (!s) return '';
  s = s.replace(/\[CQ:[^\]]*\]/g, ' '); // CQ 码
  s = s.replace(/https?:\/\/\S+/g, ' '); // 链接（念出来没意义 ✓）
  s = s.replace(/（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]/g, ' '); // 括注/动作描写 ✓
  s = s.replace(/[*_`~>#|]/g, ' '); // markdown 记号
  s = s.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
    ' ',
  ); // emoji / 箭头
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxChars) {
    // 尽量在标点处断开 ✓，不然会在句子中间戛然而止 ✗
    const cut = s.slice(0, maxChars);
    const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('，'));
    s = at > maxChars * 0.5 ? cut.slice(0, at + 1) : cut;
  }
  return s.trim();
}

/**
 * 找一个能用的 ffmpeg —— **直接复用视频那边已经实战验证过的解析器** ✓。
 *
 * ⚠️ 2026-10-14 教训：我第一版自己写了个"试 `ffmpeg -version`"的探测 ✓ ——
 * 探测**通过了**（PATH 里确实能跑 ✓），但真正调用时 `execFileSync('ffmpeg', …)` 却
 * ENOENT ✗（Node 的 PATH 解析 + 沙箱环境叠加出的怪现象 ✓）。
 * `video.mjs` 的 `resolveFfmpeg` 返回的是**绝对路径** ✓，视频抽帧一直在用 ✓ —— 复用它 ✓，
 * 不重复造（这个项目已经因为"各写一套"栽过好几次 ✓）。
 */
export function findFfmpeg(extra = '') {
  try {
    const found = resolveFfmpeg({ extra: [extra, dirname(String(extra || ''))].filter(Boolean) });
    if (found?.ffmpeg) return found.ffmpeg;
    if (typeof found === 'string' && found) return found;
  } catch {
    /* 退到下面的兜底 ✓ */
  }
  return 'ffmpeg';
}

/**
 * **WAV → OGG/Opus**（TG 语音消息的格式 ✓）。单独抽出来是为了**能单独测** ✓ ——
 * SAPI 那步依赖 COM/音频 ✗（在 DSH 沙箱里会被拒 ✓），而这一步纯 ffmpeg ✓ 哪都能跑 ✓。
 */
export function wavToOgg(wavFile, oggFile, { ffmpeg = '', bitrate = '32k' } = {}) {
  const bin = findFfmpeg(ffmpeg);
  if (!bin) throw new Error('没找到 ffmpeg（语音要它转 ogg/opus）');
  execFileSync(
    bin,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavFile, '-c:a', 'libopus', '-b:a', bitrate, '-ar', '48000', '-ac', '1', '-application', 'voip', oggFile],
    { stdio: 'ignore', timeout: 60000 },
  );
  if (!existsSync(oggFile) || statSync(oggFile).size < 500) throw new Error('ffmpeg 没转出 ogg');
  return oggFile;
}

/**
 * **合成一段语音**：返回 `{ file, bytes, ms, voice, text }` ✓（失败抛错，交给调用方降级 ✓）。
 *
 * ⚠️ **两个环境限制**（2026-10-14 实测）：
 *   1. SAPI 是 **COM** ✗ —— 在 DSH 沙箱里会**卡住/被拒** ✓（本文件就是从这里测不动的 ✓），
 *      所以这一步**只能在真正的机器人进程里生效** ✓（它在沙箱外 ✓）；
 *   2. 用 **`powershell.exe`（5.1）而不是 `pwsh`** ✓：System.Speech 在 5.1 里**原生自带** ✓，
 *      而 pwsh 7 要靠兼容包 ✓（换台机器就可能没有 ✓）。这一条是给生产环境选的 ✓。
 *
 * @param {string} text 要念的话（会自动 `cleanSpeechText` ✓）
 * @param {{outDir?:string, voice?:string, rate?:number, ffmpeg?:string, log?:object, timeoutMs?:number}} opts
 */
export async function synthesizeVoice(
  text,
  { outDir, voice = DEFAULT_VOICE, rate = DEFAULT_RATE, ffmpeg = '', log = console, timeoutMs = 60000 } = {},
) {
  const speech = cleanSpeechText(text);
  if (!speech) throw new Error('洗完没剩下能念的字（可能全是括注/表情）');
  const dir = outDir || join(tmpdir(), 'xiaodi-tts');
  mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const txtFile = join(dir, `in-${stamp}.txt`);
  const wavFile = join(dir, `out-${stamp}.wav`);
  const oggFile = join(dir, `out-${stamp}.ogg`);
  const psFile = join(dir, `tts-${stamp}.ps1`);
  const t0 = Date.now();
  try {
    // ① 文本写文件（不进命令行 ✓）+ 一段 PowerShell（同样写文件 ✓）
    writeFileSync(txtFile, speech, 'utf8');
    writeFileSync(
      psFile,
      [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.Speech',
        '$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        `$voiceName = ${JSON.stringify(String(voice))}`,
        'try { $syn.SelectVoice($voiceName) } catch { }', // 嗓子不在就退到默认 ✓
        `$syn.Rate = ${Number(rate) || 0}`,
        '$syn.Volume = 100',
        `$syn.SetOutputToWaveFile(${JSON.stringify(wavFile)})`,
        `$syn.Speak([System.IO.File]::ReadAllText(${JSON.stringify(txtFile)}, [System.Text.Encoding]::UTF8))`,
        '$syn.Dispose()',
      ].join('\r\n'),
      'utf8',
    );
    /**
     * ⚠️ 用 **Windows PowerShell 5.1**（`powershell.exe` ✓）：System.Speech 原生自带 ✓。
     * `ctrl` 交给 execFileSync 的 timeout ✓（超时它会 SIGTERM 掉子进程 ✓）。
     */
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { stdio: 'ignore', timeout: timeoutMs });
    if (!existsSync(wavFile) || statSync(wavFile).size < 1000) throw new Error('SAPI 没生成出 WAV');

    // ② WAV → OGG/Opus ✓
    wavToOgg(wavFile, oggFile, { ffmpeg });

    const bytes = statSync(oggFile).size;
    log.info?.(`[语音] 合成好了：${speech.length} 字 → ${Math.round(bytes / 1024)}KB ogg（${Date.now() - t0}ms，嗓子 ${voice}）`);
    return { file: oggFile, bytes, ms: Date.now() - t0, voice, text: speech };
  } finally {
    // 中间产物（wav/txt/ps1）用完就删 ✓ —— 只留 ogg 给发送用 ✓
    for (const f of [txtFile, wavFile, psFile]) {
      try {
        rmSync(f, { force: true });
      } catch {
        /* 删不掉不影响 ✓ */
      }
    }
  }
}
