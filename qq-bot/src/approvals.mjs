/**
 * 审批通知转发 —— **只通知，绝不代替你点「同意」**。
 *
 * 背景（2026-10-07 用户拍板）：主人不一定坐在机器前。小笛要做的是
 * 「有个审批在等你，这是它要干的事」，让他知道、决定要不要过去处理；
 * 至于"同意"这个动作，**必须回到机器上点**（或他自己用向日葵）。
 *
 * 为什么不做远程点同意（写在代码里，免得以后有人顺手加）：
 *   ① 审批是这台机器最后一道人工闸 —— 沙箱只放开工作区，要提权的动作才弹审批。
 *      把它变成 QQ 里一个按钮，等于「谁拿着那个 QQ 谁就能给这台机器提权」。
 *   ② 按坐标点 GUI 按钮不可靠（本机 AGENTS.md 记着一次真实误点事故）。
 *   ③ 审批内容里常带着即将执行的命令全文，截图发出去就进了腾讯服务器。
 * 所以这里的每一行都只**读**，不写、不注入键鼠、不应答。
 *
 * 怎么知道的：DSH 把每个会话的事件流写在
 * `~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`，
 * 审批就是一对事件 `approval/asked` / `approval/decided`（用 id 配对）。
 * 那个文件是**多帧 zstd 首尾相接**（不是单帧），所以下面按 magic 逐帧解。
 *
 * 三个必须小心的地方：
 *   1. **只读新增的字节**（记住每个文件的 offset）—— 会话文件能到几 MB，
 *      每 15 秒整份重读 + 全量解压太浪费。
 *   2. **半帧不能消费**：追加写可能读到半截 frame，那一帧要留到下一轮；
 *      否则那条审批会**永久丢掉**（静默漏报是最坏的失败方式）。
 *      ⚠️ 而"半帧"这件事**不能只看有没有抛错** —— 实测同一段被切掉尾巴的 zstd 帧：
 *        · Node **24.21.0**（DSH 现在用的运行时）：`zstdDecompressSync` 抛错 → 好办；
 *        · Node **24.18.0**（PATH 里的那个）：**不抛错，直接返回半截文本** → 旧写法会把它
 *          当成完整帧消费掉，那条审批就没了。
 *      所以最后一帧还要额外过 `looksCompleteFrame()`（行尾 + 恰好一条能 JSON.parse 的行）。
 *   3. **启动前的老审批不补发**：否则每次重启都会把历史审批翻出来刷屏。
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const FILE_NAME = 'session.v4.jsonl.zstd';

/** 默认的会话根目录。测试里会指到临时目录。 */
export function defaultSessionsDir() {
  return join(homedir(), '.dsh', 'sessions');
}

/**
 * 解出来的这段文本，看起来是不是**一整个** JSONL 帧（而不是被切断的半截）？
 *
 * 判据（都是"完整性"信号，宁可不消费也不误消费）：
 *   · 以换行结尾 —— 帧的边界就是行尾，被切断的帧几乎不可能刚好落在行尾；
 *   · 恰好一条非空行 —— 一帧一条事件（本就如此），多行说明还没读完；
 *   · 那行能 JSON.parse。
 * 误判的代价不对称：**漏消费**只是晚一轮再读（offset 不动，下轮连这段一起重读），
 * **误消费**则是那条审批永久丢失。所以这里一律从严。
 */
function looksCompleteFrame(text) {
  if (typeof text !== 'string' || !text.endsWith('\n')) return false;
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length !== 1) return false;
  try {
    JSON.parse(lines[0]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 逐帧解压一段**追加进来**的字节。
 *
 * @returns {{text:string, consumed:number}} consumed = 安全消费掉的字节数
 *   （半截的最后一帧不算，留到下一轮再读）
 */
export function decodeFrames(buf) {
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
  }
  if (!starts.length) {
    // 一个帧头都没有：可能是上一轮把帧头切开了。**留最后 3 字节**，其余当噪音跳过。
    return { text: '', consumed: Math.max(0, buf.length - 3) };
  }

  const texts = [];
  let consumed = 0;
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    const isLast = k + 1 >= starts.length;
    const slice = buf.subarray(start, end);
    let ok = false;
    for (let trim = 0; trim < 4 && !ok; trim++) {
      try {
        const text = zstdDecompressSync(slice.subarray(0, slice.length - trim)).toString('utf8');
        // ⚠️ 最后一帧要**看起来完整**才算数：有些 Node 版本对切掉尾巴的帧照样"成功"返回半截文本
        //    （24.18 实测），只看有没有抛错会把那条审批吃掉。非最后一帧不用查 —— 后面还有帧头，
        //    边界是确定的。
        if (isLast && !looksCompleteFrame(text)) break; // 再 trim 也没有意义，直接停在这里
        texts.push(text);
        consumed = end - trim;
        ok = true;
      } catch {
        /* 半截帧 —— 试下一个 trim，都不行就停下 */
      }
    }
    if (!ok) break; // 没解出来：**不推进**，下一轮连这段一起重读
  }
  return { text: texts.join(''), consumed };
}

/**
 * 从一段 JSONL 文本里挑出审批事件。
 * @returns {{asked:Map<string,object>, decided:Set<string>}}
 */
export function parseApprovalEvents(text) {
  const asked = new Map();
  const decided = new Set();
  for (const line of text.split('\n')) {
    if (!line.includes('approval/')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // 半行（下次读就完整了）
    }
    const id = String(e?.data?.id ?? '');
    if (!id) continue;
    if (e.type === 'approval/asked') {
      asked.set(id, {
        id,
        toolName: String(e?.data?.toolName ?? '?'),
        reason: String(e?.data?.reason ?? '').trim(),
        time: Number(e?.time ?? 0),
      });
    } else if (e.type === 'approval/decided') {
      decided.add(id);
    }
  }
  return { asked, decided };
}

/** 一条审批 → 发给主人的话。 */
export function formatApproval(a, when = Date.now()) {
  const lines = ['有个审批在等你（我只看得到，不能替你点）：', '', `工具：${a.toolName}`];
  if (a.reason) lines.push(`原因：${a.reason.length > 300 ? `${a.reason.slice(0, 300)}…` : a.reason}`);
  if (a.session) lines.push(`会话：${a.session}${a.workspace ? `（${a.workspace}）` : ''}`);
  const gap = when - (a.time || when);
  if (gap > 60 * 1000) lines.push(`（等了约 ${Math.round(gap / 60000)} 分钟了）`);
  lines.push('', '要同意得回机器上点 —— 这条路我故意没做。');
  return lines.join('\n');
}

/**
 * 盯住所有会话文件的新增部分，捡出还没被回答的审批。
 * **只读文件**，不碰任何 DSH 内部接口。
 */
export class ApprovalWatcher {
  constructor({ dir = defaultSessionsDir(), log = console, startedAt = Date.now(), maxHistory = 500 } = {}) {
    this.dir = dir;
    this.log = log;
    this.startedAt = startedAt;
    this.maxHistory = maxHistory;
    this.offsets = new Map(); // relPath -> 已消费的字节数
    this.seen = new Set(); // 已通知过的审批 id
    /**
     * **开局先只记住每个文件当前有多大**，历史字节一律不读。
     *
     * 为什么：`~/.dsh/sessions` 现在是 20 个文件、解出来 68 MB 文本 ——
     * 第一轮全量解压要 0.8 秒，而那 0.8 秒是**卡在机器人的事件循环**上的。
     * 而历史审批本来就全部「已决定」（实测 61 asked / 61 decided），读了也是白读。
     * 这样第一个 15 秒窗口里的新审批一条都不会漏（构造发生在启动那一刻）。
     */
    this.#prime();
  }

  /** 记下当前所有会话文件的大小，作为起点。 */
  #prime() {
    for (const rel of this.listFiles()) {
      try {
        this.offsets.set(rel, statSync(join(this.dir, rel)).size);
      } catch {
        /* 读不到就算了，下次按 0 开始 */
      }
    }
  }

  /** 所有会话文件（相对 sessions 根目录的路径）。 */
  listFiles() {
    try {
      return readdirSync(this.dir, { recursive: true })
        .map((p) => String(p))
        .filter((p) => p.endsWith(FILE_NAME));
    } catch {
      return []; // 目录还不存在（DSH 没跑过）—— 不是错误
    }
  }

  /** 读一个文件**新增**的那段字节，返回解出来的文本。 */
  readNew(relPath) {
    const abs = join(this.dir, relPath);
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      return '';
    }
    const prev = this.offsets.get(relPath) ?? 0;
    if (size === prev) return '';
    if (size < prev) {
      // 文件被换小了（会话重写/清空）—— 从头再来
      this.offsets.set(relPath, 0);
      return '';
    }
    const len = size - prev;
    const buf = Buffer.alloc(len);
    const fd = openSync(abs, 'r');
    try {
      readSync(fd, buf, 0, len, prev);
    } finally {
      closeSync(fd);
    }
    const { text, consumed } = decodeFrames(buf);
    this.offsets.set(relPath, prev + consumed);
    return text;
  }

  /**
   * 扫一轮。返回**这一轮新发现、且还没被回答**的审批（每 id 只报一次）。
   */
  poll() {    const out = [];
    for (const rel of this.listFiles()) {
      let text = '';
      try {
        text = this.readNew(rel);
      } catch (err) {
        this.log.warn?.(`读会话文件失败 ${rel}：${err.message}`);
        continue;
      }
      if (!text) continue;
      const { asked, decided } = parseApprovalEvents(text);
      for (const [id, info] of asked) {
        if (decided.has(id) || this.seen.has(id)) continue;
        if (info.time && info.time < this.startedAt) continue; // 老审批不补发
        this.seen.add(id);
        const parts = rel.split(sep);
        out.push({
          ...info,
          session: parts.length >= 2 ? parts[parts.length - 2] : rel,
          workspace: parts.length >= 3 ? parts[0] : '',
        });
      }
      if (this.seen.size > this.maxHistory) {
        // 只留最近的，避免长期运行把内存里的 id 越堆越多
        const keep = [...this.seen].slice(-Math.floor(this.maxHistory / 2));
        this.seen = new Set(keep);
      }
    }
    return out;
  }

  /** 某条没发出去（比如 OneBot 掉线）→ 放回队列，下一轮重新报。 */
  forget(id) {
    this.seen.delete(String(id));
  }
}
