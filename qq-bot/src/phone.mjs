/**
 * **让她能"玩手机"**：通过 **ADB** 驱动雷电模拟器（2026-10-19 用户要求）。
 *
 * 为什么走 ADB 而不是"模拟点鼠标" ✗：
 *   · 点鼠标要 DPI/注入/坐标一堆坑（见全局 AGENTS.md §1、§3）✓；
 *   · 雷电自带 `adb.exe` ✓，`input tap/swipe/text/keyevent` 是**确定性的** ✓；
 *   · `exec-out screencap -p` 能直接拿到一张 PNG ✓ ⇒ 她能**看着屏幕**做决定 ✓（识图现成 ✓）。
 *
 * ⚠️ 边界（**默认关闭** ✓，`config.phone.enabled` 才启用）：
 *   · 只操作**这台模拟器** ✓（`-s <serial>` ✓），绝不碰真手机 ✓；
 *   · **安装/卸载**这类写动作**由上层（bot.mjs）先要主人点头** ✓，本模块只管执行 ✓；
 *   · **黑名单**：支付/银行/相册/通讯录/设置 一律拒绝 ✓（宁可不做 ✓）。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** 碰了会出事的包名/关键词 —— 一律拒绝（fail-closed） */
const DENY = /bank|pay|alipay|wechat|tencent\.mm|wallet|photos|gallery|contacts|dialer|packageinstaller|settings|permission|secure/i;

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

function run(exe, args, { timeout = 20000, binary = false } = {}) {
  return new Promise((resolve) => {
    /**
     * ⚠️ `execFile` 在"**spawn 阶段**就失败"时会**同步抛出** ✗（实测沙箱里 `spawn EPERM` ✓，
     * 而机器人跑在沙箱外不受影响 ✓）—— 不 try 的话它会**越过 Promise 冒到外面** ✓，
     * 把整条对话打断 ✗。这里统一兜成 `{ok:false}` ✓。
     */
    try {
      execFile(exe, args, { timeout, encoding: binary ? 'buffer' : 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, out: '', err: String(stderr || err.message || '').trim().slice(0, 300), code: err.code ?? -1 });
        else resolve({ ok: true, out: binary ? stdout : String(stdout ?? '').trim(), err: String(stderr ?? '').trim().slice(0, 300), code: 0 });
      });
    } catch (e) {
      resolve({ ok: false, out: '', err: '起不了进程：' + String(e?.message ?? e).slice(0, 200), code: e?.code ?? -1 });
    }
  });
}

export function createPhone({ adb = 'D:\\leidian\\LDPlayer9\\adb.exe', ld = 'D:\\leidian\\LDPlayer9\\ld.exe', serial = '', log = console } = {}) {
  const logFn = (m) => log?.info?.(m) ?? log?.log?.(m);

  /**
   * **只认模拟器**（2026-10-19 血的教训 ✗）：雷电是 `emulator-5554` ✓、MuMu 是 `127.0.0.1:7555` ✓；
   * 真机的 serial 是 `10AFBS3EQB0049G` 这种 ✗ —— **绝不能被选中** ✓。
   */
  const isEmulatorSerial = (s) => /^emulator-\d+$/.test(String(s)) || /^127\.0\.0\.1:\d{2,5}$/.test(String(s));

  /** 选设备：**只选模拟器** ✓（用户可能同时插着真机 ✗） */
  async function pick() {
    const r = await run(adb, ['devices']);
    if (!r.ok) return { ok: false, err: 'adb 跑不起来：' + r.err };
    const rows = r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('List of devices'));
    const on = rows.map((l) => l.split(/\s+/)).filter((p) => p[1] === 'device');
    const emu = on.filter((p) => isEmulatorSerial(p[0]));
    const real = on.filter((p) => !isEmulatorSerial(p[0]));
    const note = real.length ? `（另有 ${real.length} 台**真机**已连接 —— 我不碰 ✗）` : '';
    if (serial) {
      if (!isEmulatorSerial(serial)) return { ok: false, err: '配置里的 serial 不是模拟器（' + serial + '）—— 拒绝操作真机 ✗' };
      const hit = emu.find((p) => p[0] === serial);
      return hit ? { ok: true, serial: hit[0] } : { ok: false, err: `模拟器 ${serial} 不在线${note}` };
    }
    if (!emu.length) return { ok: false, err: '没有在线的**模拟器**（先把雷电开起来）' + note };
    return { ok: true, serial: emu[0][0] };
  }

  const sh = async (cmd, opts) => {
    const p = await pick();
    if (!p.ok) return { ok: false, err: p.err };
    const r = await run(adb, ['-s', p.serial, 'shell', ...cmd], opts);
    return r.ok ? { ok: true, out: r.out, serial: p.serial } : { ok: false, err: r.err, serial: p.serial };
  };

  /** 状态：设备 / 型号 / 分辨率 / 当前前台 */
  async function status() {
    const p = await pick();
    if (!p.ok) return { ok: false, err: p.err };
    const [model, size, focus] = await Promise.all([
      sh(['getprop', 'ro.product.model']),
      sh(['wm', 'size']),
      sh(['dumpsys', 'window', '|', 'grep', 'mCurrentFocus']),
    ]);
    return {
      ok: true,
      serial: p.serial,
      model: model.out || '',
      size: size.out || '',
      focus: focus.out || '',
    };
  }

  /** 启动模拟器（`ld -<n>`）并等它上线 */
  async function start({ index = 1, waitMs = 90000 } = {}) {
    if (!existsSync(ld)) return { ok: false, err: '找不到 ld.exe：' + ld };
    const p = await pick();
    if (p.ok) return { ok: true, out: `已经在跑：${p.serial}`, already: true };
    logFn('[手机] 启动雷电模拟器…');
    await run(ld, ['-' + index], { timeout: 15000 }); // 它会立刻返回，模拟器在后台起
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      await new Promise((r) => setTimeout(r, 2000));
      const q = await pick();
      if (q.ok) {
        // 起来后等 Android 完全开机（boot_completed）
        for (let i = 0; i < 30; i += 1) {
          const b = await sh(['getprop', 'sys.boot_completed']);
          if (b.ok && String(b.out).trim() === '1') return { ok: true, out: `起来了：${q.serial}` };
          await new Promise((r) => setTimeout(r, 2000));
        }
        return { ok: true, out: `起来了（但还没完全开机完）：${q.serial}` };
      }
    }
    return { ok: false, err: '等了 ' + Math.round(waitMs / 1000) + ' 秒还没上线' };
  }

  /**
   * **界面结构**：`uiautomator dump` → 解析出可点元素（文字 + 精确 pixel bounds）✓。
   * 这样她点的是**真实坐标** ✓，不用从缩略图上猜 ✗（实测猜的会差一截 ✓）。
   * @param {number} max 最多返回多少个可点元素（防止一次塞几百行）
   */
  async function uiDump({ max = 40 } = {}) {
    await sh(['uiautomator', 'dump', '/sdcard/ui.xml']);
    const r = await sh(['cat', '/sdcard/ui.xml']);
    if (!r.ok) return { ok: false, err: r.err };
    const xml = String(r.out);
    const out = [];
    const re = /<node\b[^>]*?\btext="([^"]*)"[^>]*?\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*?>/g;
    for (const m of xml.matchAll(re)) {
      const text = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      if (!text) continue;
      const x1 = Number(m[2]), y1 = Number(m[3]), x2 = Number(m[4]), y2 = Number(m[5]);
      if (x2 - x1 < 8 || y2 - y1 < 8) continue;
      out.push({ text: text.slice(0, 40), x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), w: x2 - x1, h: y2 - y1 });
      if (out.length >= max) break;
    }
    // 去重（同一行常常套两层）
    const seen = new Set();
    const uniq = out.filter((o) => { const k = o.text + '@' + o.x + ',' + o.y; if (seen.has(k)) return false; seen.add(k); return true; });
    return { ok: true, items: uniq };
  }

  /** 截一张图（返回 PNG Buffer） */
  async function screenshot() {
    const p = await pick();
    if (!p.ok) return { ok: false, err: p.err };
    const r = await run(adb, ['-s', p.serial, 'exec-out', 'screencap', '-p'], { binary: true, timeout: 30000 });
    if (!r.ok) return { ok: false, err: r.err };
    const buf = r.out;
    if (!Buffer.isBuffer(buf) || buf.length < 1000 || buf[0] !== 0x89 || buf[1] !== 0x50) {
      return { ok: false, err: '拿到的不是 PNG（' + (buf?.length ?? 0) + ' 字节）' };
    }
    return { ok: true, png: buf, serial: p.serial };
  }

  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

  async function tap(x, y) {
    return sh(['input', 'tap', String(clampInt(x, 0, 10000)), String(clampInt(y, 0, 10000))]);
  }

  /**
   * **验证式点击**（2026-10-20 真机死循环挖出来的）：
   * 日志里她连着点 (900,1330)/(880,1340)/(1280,1030)，**界面没变** ✗，
   * 而她靠识图“看”不出自己点空了 ✗ ⇒ 12 轮白跑、最后回复退化成「……~」✗。
   *
   * ⚠️ 第一版用 **SHA256 比对整张图** ✗ —— 真机实测**点空白也报"有变化"** ✗：
   *    游戏界面有**待机动画/闪屏** ✓，每一帧都不同 ✓ ⇒ 改成**容忍微小变化的块级比对** ✓：
   *   缩到 **64×36** 再逐格比 ✓，只有**变化格子占比 > 2%** 才算"界面真的变了" ✓。
   */
  async function frameGrid(pngBuf, w = 64, h = 36) {
    const inP = join(tmpdir(), 'tapv-' + process.pid + '-' + Date.now() + '.png');
    const outP = inP.replace(/\.png$/, '.raw');
    try {
      writeFileSync(inP, pngBuf);
      const ok = await new Promise((resolve) => {
        try {
          execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', inP, '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', outP], { timeout: 15000, windowsHide: true }, (err) => resolve(!err));
        } catch {
          resolve(false);
        }
      });
      if (!ok) return null;
      const raw = readFileSync(outP);
      return raw.length === w * h * 3 ? raw : null;
    } catch {
      return null;
    } finally {
      try { writeFileSync(inP, ''); writeFileSync(outP, ''); } catch { /* 忽略 */ }
    }
  }
  /** 两帧的"变化格子占比"（0~1）；拿不到就 null */
  function diffRatio(a, b) {
    if (!a || !b || a.length !== b.length) return null;
    const cells = a.length / 3;
    let changed = 0;
    for (let i = 0; i < a.length; i += 3) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > 45) changed += 1;
    }
    return changed / cells;
  }

  async function tapVerified(x, y, { settleMs = 900, minRatio = 0.02 } = {}) {
    const cx = clampInt(x, 0, 10000);
    const cy = clampInt(y, 0, 10000);
    const before = await screenshot();
    const t = await tap(cx, cy);
    if (!t.ok) return { ok: false, err: t.err, changed: null };
    await new Promise((r) => setTimeout(r, settleMs));
    const after = await screenshot();
    if (!before.ok || !after.ok) return { ok: true, changed: null, err: '截不到对比图' };
    const g1 = await frameGrid(before.png);
    const g2 = await frameGrid(after.png);
    const ratio = diffRatio(g1, g2);
    if (ratio === null) return { ok: true, changed: null, err: '没法比帧（ffmpeg 不可用？）' };
    return { ok: true, changed: ratio > minRatio, ratio, at: [cx, cy], bytes: after.png.length };
  }
  async function swipe(x1, y1, x2, y2, ms = 300) {
    return sh(['input', 'swipe', String(clampInt(x1, 0, 10000)), String(clampInt(y1, 0, 10000)), String(clampInt(x2, 0, 10000)), String(clampInt(y2, 0, 10000)), String(clampInt(ms, 50, 5000))]);
  }
  /** 打字：空格用 %s（adb 的历史坑 ✓），中文靠输入法——所以先不支持中文，只送 ASCII */
  async function type(text) {
    const s = String(text ?? '').slice(0, 200).replace(/[^\x20-\x7e]/g, '').replace(/ /g, '%s');
    if (!s) return { ok: false, err: '只能送 ASCII（中文要用输入法，暂时不支持）' };
    return sh(['input', 'text', s]);
  }
  const KEYS = { back: 4, home: 3, recents: 187, enter: 66, delete: 67, power: 26, volup: 24, voldown: 25 };
  async function key(name) {
    const code = KEYS[String(name ?? '').toLowerCase()];
    if (!code) return { ok: false, err: '不认识的键：' + name + '（可用：' + Object.keys(KEYS).join('/') + '）' };
    return sh(['input', 'keyevent', String(code)]);
  }
  /** 装了哪些第三方 App（包名 → 尽量带上应用名） */
  async function apps() {
    const r = await sh(['pm', 'list', 'packages', '-3']);
    if (!r.ok) return r;
    const list = String(r.out).split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean);
    return { ok: true, out: list };
  }
  async function open(pkg) {
    const p = String(pkg ?? '').trim();
    if (!/^[a-zA-Z][\w.]{2,80}$/.test(p)) return { ok: false, err: '包名不合法：' + pkg };
    if (DENY.test(p)) return { ok: false, err: '这个包在黑名单里（支付/相册/通讯录这类不碰）' };
    const r = await sh(['monkey', '-p', p, '-c', 'android.intent.category.LAUNCHER', '1']);
    return r.ok ? { ok: true, out: '已尝试打开 ' + p } : r;
  }
  /** 安装 APK（**上层必须先拿到主人点头** ✓） */
  async function install(apkPath) {
    const p = String(apkPath ?? '').trim();
    if (!existsSync(p)) return { ok: false, err: '找不到 APK：' + p };
    const dev = await pick();
    if (!dev.ok) return { ok: false, err: dev.err };
    const r = await run(adb, ['-s', dev.serial, 'install', '-r', p], { timeout: 180000 });
    return r.ok && /Success/i.test(r.out) ? { ok: true, out: '装好了：' + p } : { ok: false, err: r.err || r.out };
  }

  return { status, start, screenshot, tap, tapVerified, swipe, type, key, apps, open, install, uiDump, pick };
}
