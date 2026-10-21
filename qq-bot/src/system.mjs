/**
 * 只读的电脑状态采集 —— 「状态 / 进程 / 窗口」三个主人命令的实现。
 *
 * **这个模块只读**：不写配置、不动文件、不注入键鼠。它存在的唯一目的是让主人
 * 从 QQ 里看一眼这台机器的状况。
 *
 * 两条实现路线，刻意分开：
 *
 * 1. **CPU / 内存 / 磁盘 / 开机时长走 Node 内置**（`node:os` + `fs.statfsSync`），
 *    不调任何外部程序。这条路上不存在「调不动」的可能。
 * 2. **进程列表与窗口列表没有纯 JS 实现**，只能问 PowerShell。而 node 直接
 *    pipe 子进程的 stdio 在 DSH 沙箱下会被拒（named pipe → EPERM，
 *    和 `src/zip.mjs` 开头记的是同一个坑）。所以这里**让 PowerShell 自己把结果
 *    写进临时文件**，Node 再读文件 —— 实测沙箱内外都能跑（stdio 用 'ignore'，
 *    不碰管道）。拿不到就**明说拿不到**，绝不静默给一张空表。
 *
 * ⚠️ **不提权会被少报**（本机实测过：不提权只看得到 7 个进程名，提权后 325 个）。
 * 所以采集时顺手把「当前是不是管理员」一起读回来，附在回复里——
 * 数字不可信时用户得知道。小笛自己是提权跑的（见 `start-all.ps1`）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statfsSync } from 'node:fs';
import { cpus, freemem, hostname, tmpdir, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './config.mjs';

/** 问 PowerShell 的超时。宁可回「拿不到」，也不能把机器人卡住。 */
const PS_TIMEOUT_MS = 8000;
/** 默认列几个进程。 */
const TOP_PROCESSES = 8;
/** 窗口最多列几个（标题截断到 40 字）。 */
const MAX_WINDOWS = 25;
const TITLE_MAX = 40;

/** 1 GB，按 1024 算（任务管理器那套）。 */
const GB = 1024 ** 3;

/**
 * 找 PowerShell：先 pwsh（7.x），没有就退回系统自带的 powershell.exe。
 * 和 `start-all.ps1` 的 `Resolve-Pwsh` 同一套探测顺序。
 */
export function resolvePowerShell() {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    join(process.env.ProgramFiles ?? '', 'PowerShell', '7', 'pwsh.exe'),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return 'powershell.exe';
}

/** 人类可读的体积。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const gb = bytes / GB;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** 人类可读的时长（开机时长那种）。 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时 ${mins} 分`;
  if (hours > 0) return `${hours} 小时 ${mins} 分`;
  return `${mins} 分`;
}

/**
 * 采一次 CPU 占用：`os.cpus()` 给的是**累计**时间，必须隔一小会儿采两次做差。
 * Windows 上 `os.loadavg()` 恒为 0，用不了。
 */
export async function sampleCpuPercent(gapMs = 150) {
  const snap = () => cpus().reduce((acc, c) => {
    const t = Object.values(c.times).reduce((a, b) => a + b, 0);
    return { idle: acc.idle + c.times.idle, total: acc.total + t };
  }, { idle: 0, total: 0 });

  const a = snap();
  await new Promise((r) => setTimeout(r, gapMs));
  const b = snap();
  const totalDelta = b.total - a.total;
  const idleDelta = b.idle - a.idle;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

/**
 * 列本机所有能读到的盘。走 `fs.statfsSync`，**不调外部程序**。
 * 读不到的（空光驱、没插卡的读卡器）直接跳过——它们不是「错误」。
 * iSCSI 挂上来之后会以普通盘符出现在这里。
 */
export function listDrives() {
  const out = [];
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    const root = `${letter}:\\`;
    try {
      const st = statfsSync(root);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      if (total > 0) out.push({ name: `${letter}:`, total, free });
    } catch {
      // 不存在 / 不可读 —— 跳过
    }
  }
  return out;
}

/** 采状态。这里**没有任何外部调用**，永远能成功。 */
export async function collectStatus() {
  const cpuList = cpus();
  return {
    host: hostname(),
    cpuModel: (cpuList[0]?.model ?? '未知 CPU').replace(/\s+/g, ' ').trim(),
    cpuCount: cpuList.length,
    cpuPercent: await sampleCpuPercent(),
    memTotal: totalmem(),
    memFree: freemem(),
    uptimeSec: uptime(),
    drives: listDrives(),
  };
}

/** 状态 → QQ 文本。 */
export function formatStatus(info) {
  const memUsedPct = info.memTotal > 0 ? Math.round((1 - info.memFree / info.memTotal) * 100) : null;
  const drives = info.drives.length
    ? info.drives.map((d) => `${d.name} 剩 ${formatBytes(d.free)} / ${formatBytes(d.total)}`).join('\n      ')
    : '（一个都没读到）';

  return [
    `这台电脑（${info.host}）：`,
    '',
    `CPU   ${info.cpuModel} · ${info.cpuCount} 线程`,
    `      当前负载 ${info.cpuPercent === null ? '读不到' : `${info.cpuPercent}%`}`,
    `内存   可用 ${formatBytes(info.memFree)} / 共 ${formatBytes(info.memTotal)}（已用 ${memUsedPct ?? '?'}%）`,
    `磁盘   ${drives}`,
    `开机   ${formatDuration(info.uptimeSec)}`,
    '',
    '（只读，不改任何东西）',
  ].join('\n');
}

/** 问一次 PowerShell，结果从临时文件里读回来。 */
async function runPowerShell(query, { timeoutMs = PS_TIMEOUT_MS } = {}) {
  const exe = resolvePowerShell();
  // 路径里的单引号要按 PowerShell 的规矩双写，否则路径里带 ' 会拼坏脚本。
  const file = join(tmpdir(), `dsh-bot-sys-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const quoted = file.replace(/'/g, "''");
  // 查询本身出错时必须**留下痕迹**：静默的空数组会被当成「一个进程都没有」，
  // 那是"看起来正常"的错误答案。所以把异常文本也塞进 JSON 里带回来。
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    '$err = ""',
    '$items = @()',
    `try { $items = @(${query}) } catch { $err = "$($_.Exception.Message)" }`,
    `ConvertTo-Json -Compress -Depth 4 -InputObject @{ admin = $admin; error = $err; items = $items } | Out-File -LiteralPath '${quoted}' -Encoding utf8`,
  ].join('\n');

  let child;
  try {
    child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, error: `调不动 PowerShell（${err.code ?? err.message}）` };
  }

  const result = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已经退了 */ }
      resolve({ ok: false, error: `PowerShell ${timeoutMs / 1000} 秒没返回` });
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = err?.code ?? err?.message;
      resolve({
        ok: false,
        error: code === 'EPERM'
          ? 'PowerShell 调用被拒（EPERM）—— 小笛大概是从 DSH 沙箱里启动的，用桌面快捷方式重启试试'
          : `启动 PowerShell 失败（${code}）`,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, error: code === 0 ? null : `PowerShell 退出码 ${code}` });
    });
  });

  if (!result.ok) {
    rmSync(file, { force: true });
    return result;
  }

  try {
    // PS 5.1 的 Out-File -Encoding utf8 会写 BOM，读回来要先摘掉，否则 JSON.parse 炸。
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!text) return { ok: false, error: 'PowerShell 没写出内容' };
    const data = JSON.parse(text);
    const psError = String(data.error ?? '').trim();
    if (psError) return { ok: false, error: `查询出错（${psError.split('\n')[0].slice(0, 120)}）` };
    // PS 5.1 的 ConvertTo-Json 偶尔把单元素数组写成裸对象，这里补一手。
    const items = Array.isArray(data.items)
      ? data.items
      : data.items && typeof data.items === 'object'
        ? [data.items]
        : [];
    return { ok: true, admin: data.admin === true, items };
  } catch (err) {
    return { ok: false, error: `读结果失败（${err.message}）` };
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * 占内存最多的几个进程。
 * ⚠️ 工作集是**逐进程重复计入共享页**的，所以各进程 WS 加起来超过物理内存是正常的。
 */
export async function collectProcesses({ top = TOP_PROCESSES, timeoutMs } = {}) {
  const query = `Get-Process | Sort-Object WS -Descending | Select-Object -First ${top} Name, Id, WS`;
  const res = await runPowerShell(query, { timeoutMs });
  if (!res.ok) return res;
  return {
    ok: true,
    admin: res.admin,
    rows: res.items.map((p) => ({
      name: String(p.Name ?? '?'),
      pid: Number(p.Id ?? 0),
      ws: Number(p.WS ?? 0),
    })),
  };
}

/**
 * 当前带窗口的程序。
 *
 * ⚠️ **必须走 `EnumWindows`，不能用 `Get-Process` 的 `MainWindowTitle`。**
 * 2026-10-07 真实踩过：受限/非提权上下文里 `MainWindowTitle` 对别的进程返回**空**，
 * 于是「现在有哪些窗口」答成了「一个带窗口的程序都没有」——而机器上明明开着 14 个。
 * 同一台机器上 `EnumWindows` 枚举正常。
 */
export async function collectWindows({ max = MAX_WINDOWS, timeoutMs } = {}) {
  const res = await runPowerShellScript(
    join(ROOT, 'tools', 'win-control.ps1'),
    ['-Action', 'list-windows'],
    { timeoutMs },
  );
  if (!res.ok) return res;
  const items = Array.isArray(res.data.windows) ? res.data.windows : [];
  return {
    ok: true,
    admin: res.data.admin === true,
    rows: items.slice(0, max).map((w) => ({
      name: String(w.proc ?? '?'),
      pid: Number(w.pid ?? 0),
      title: String(w.title ?? '').replace(/\s+/g, ' ').trim(),
    })),
  };
}

/** 少报提醒：不提权时进程/窗口数据是残缺的，必须说出来。 */function adminNote(admin) {
  return admin
    ? null
    : '（⚠️ 当前不是管理员权限，这份列表是**少报**的 —— 「看不见」不等于「不存在」）';
}

/** 进程列表 → QQ 文本。 */
export function formatProcesses(res) {
  if (!res.ok) return `进程列表拿不到：${res.error}`;
  if (!res.rows.length) return '一个进程都没读到（这本身就说明有问题）。';
  const lines = res.rows.map((p) => `${formatBytes(p.ws).padStart(8)}  ${p.name}  (${p.pid})`);
  const note = adminNote(res.admin);
  return [
    `占内存最多的 ${res.rows.length} 个进程：`,
    '',
    ...lines,
    '',
    note ?? '（工作集合计会重复计入共享页，加起来超过物理内存属正常）',
  ].join('\n');
}

/** 窗口列表 → QQ 文本。 */
export function formatWindows(res) {
  if (!res.ok) return `窗口列表拿不到：${res.error}`;
  if (!res.rows.length) return '现在没有任何带窗口的程序。';
  const lines = res.rows.map((w) => {
    const title = w.title.length > TITLE_MAX ? `${w.title.slice(0, TITLE_MAX)}…` : w.title;
    return `${w.name} — ${title}`;
  });
  // ⚠️ 这里**不能**用「不是管理员 = 少报」那句（窗口枚举不受提权影响，EnumWindows 看得到全部）。
  // 真正会缺的是**进程名**：受限上下文里拿不到别人家进程的名字，只能显示 '?'。
  const unknown = res.rows.some((w) => !w.name || w.name === '?');
  const note = unknown
    ? '（只读。有几个显示 ? 的是**进程名读不到**——权限不够，窗口本身没问题）'
    : '（只读，不改任何东西）';
  return [`现在有窗口的程序（${res.rows.length} 个）：`, '', ...lines, '', note].join('\n');
}

/**
 * 跑一个**带参数的 .ps1 文件**，结果仍从「脚本自己写的 JSON 文件」里读回来。
 *
 * 为什么不做成 `-Command` 内联：音量要 Core Audio 的 C# 互操作、截图要 PrintWindow，
 * 塞进 JS 模板字符串里就没法脱离机器人单独验了。脚本放 `tools/win-control.ps1`，
 * 既能被机器人调，也能手敲一行命令单独跑。
 *
 * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
 */
export async function runPowerShellScript(scriptPath, args = [], { timeoutMs = PS_TIMEOUT_MS } = {}) {
  const exe = resolvePowerShell();
  const resultFile = join(tmpdir(), `dsh-bot-ctl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const argv = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    ...args.map(String),
    '-Result',
    resultFile,
  ];

  let child;
  try {
    child = spawn(exe, argv, { stdio: 'ignore', windowsHide: true });
  } catch (err) {
    return { ok: false, error: `调不动 PowerShell（${err.code ?? err.message}）` };
  }

  const exited = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已经退了 */ }
      resolve({ ok: false, error: `脚本 ${timeoutMs / 1000} 秒没返回` });
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `启动失败（${err?.code ?? err?.message}）` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, code });
    });
  });

  try {
    if (!exited.ok) return exited;
    const text = readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!text) return { ok: false, error: `脚本没写出结果（退出码 ${exited.code}）` };
    const data = JSON.parse(text);
    if (data.ok !== true) return { ok: false, data, error: data.error ?? '脚本报告失败' };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `读结果失败（${err.message}）` };
  } finally {
    rmSync(resultFile, { force: true });
  }
}
