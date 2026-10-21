# 小笛的「动手」脚本：音量 / 媒体键 / 窗口截图 / 关窗口。
#
# 为什么单独一个文件而不是把 C# 塞进 JS 字符串：这里全是 Win32 + COM 互操作，
# 放在 .ps1 里能**脱离机器人单独跑**、单独验（`pwsh tools/win-control.ps1 -Action volume-get -Result out.json`），
# 塞进 JS 模板字符串里就只能靠重启机器人来调试了。
#
# 约定：
#   · 结果**永远**写进 -Result 指定的 JSON（成功失败都写），调用方只认那个文件；
#   · 不打印业务数据到 stdout（Node 那边的管道在沙箱下会被拒，见 src/system.mjs）；
#   · 出错**不吞**，错误原文进 JSON 的 error 字段。
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('volume-get', 'volume-set', 'audio-peak', 'media', 'screenshot', 'close-window', 'list-windows')]
  [string]$Action,

  [Parameter(Mandatory = $true)][string]$Result,

  [string]$Out = '',            # screenshot 的输出 PNG
  [double]$Level = -1,          # volume-set：0..1
  [string]$Mute = '',           # volume-set：'true' / 'false' / 空=不改
  [string]$MediaAction = '',    # media：play_pause | next | prev | stop
  [string]$Match = '',          # screenshot / close-window：窗口标题或进程名子串
  [string]$Blocklist = ''       # 逗号分隔：命中的进程名一律拒绝截图
)

$ErrorActionPreference = 'Stop'
# ⚠️ 这个变量**不能叫 $result**：PowerShell 变量名大小写不敏感，
# 参数 `-Result` 和它其实是同一个变量，赋值会把参数覆盖掉（踩过：结果文件根本没写出来）。
$res = @{ ok = $false; action = $Action; error = '没有走到任何分支' }

function Write-Result {
  if ($res.ok) { [void]$res.Remove('error') }   # 成功时别留一句「没有走到任何分支」的噪音
  $json = $res | ConvertTo-Json -Compress -Depth 5
  # 统一 utf8（PS5.1 会带 BOM，Node 侧会摘掉）
  [System.IO.File]::WriteAllText($Result, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ─────────────────────────── Win32 / COM 声明 ───────────────────────────
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinCtl {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  public class Win {
    public string Class { get; set; }   // 2026-10-17：窗口类名（GLFW30 = 我的世界 Java）
    public IntPtr H;
    public string Title;
    public string Proc;
    public int Pid, Left, Top, W, Hh;
    public bool Min;
  }

  // 2026-10-17 加：窗口类名。为什么需要它 —— 我的世界(Java) 的**标题随整合包变** ✗，
  // 但类名恒为 GLFW30 ✓ ⇒ 用户说「mc」时用类名匹配，换整合包也不怕 ✓。
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  static string ClassOf(IntPtr h) { try { var sb = new StringBuilder(256); GetClassNameW(h, sb, sb.Capacity); return sb.ToString(); } catch { return ""; } }

  public static List<Win> Windows() {
    var list = new List<Win>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, sb.Capacity);
      string t = sb.ToString().Trim();
      if (t.Length == 0) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int pid; GetWindowThreadProcessId(h, out pid);
      string proc = "?";
      try { proc = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { }
      list.Add(new Win {
        H = h, Title = t, Proc = proc, Pid = pid,
        Left = r.Left, Top = r.Top, W = r.Right - r.Left, Hh = r.Bottom - r.Top,
        Min = IsIconic(h), Class = ClassOf(h)
      });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool Close(IntPtr h) {
    // WM_CLOSE = 点右上角那个 X，走的是应用自己的「要退出吗」流程（不是强杀）
    SendMessageW(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
    return true;
  }
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr p);
  int UnregisterControlChangeNotify(IntPtr p);
  int GetChannelCount(out int c);
  int SetMasterVolumeLevel(float f, ref Guid g);
  int SetMasterVolumeLevelScalar(float f, ref Guid g);
  int GetMasterVolumeLevel(out float f);
  int GetMasterVolumeLevelScalar(out float f);
  int SetChannelVolumeLevel(uint ch, float f, ref Guid g);
  int SetChannelVolumeLevelScalar(uint ch, float f, ref Guid g);
  int GetChannelVolumeLevel(uint ch, out float f);
  int GetChannelVolumeLevelScalar(uint ch, out float f);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int mask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  int GetDevice(string id, out IMMDevice device);
  int RegisterEndpointNotificationCallback(IntPtr cb);
  int UnregisterEndpointNotificationCallback(IntPtr cb);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(uint access, out IntPtr props);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out uint state);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

// 「现在到底有没有声音」：读默认播放设备的电平峰值。
// 为什么要它：媒体键是**盲按** —— 按下去到底有没有生效，光看 SendInput 的返回值看不出来
// （2026-10-07 实测：SendInput 返回 2 条、GetLastError=0，而音乐照放）。
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation {
  int GetPeakValue(out float pfPeak);
  int GetMeteringChannelCount(out int pnChannelCount);
  int GetChannelsPeakValues(int u32ChannelCount, [Out] float[] afPeakValues);
  int QueryHardwareSupport(out int pdwHardwareSupportMask);
}

public class Meter {
  private static IAudioMeterInformation M() {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 0, out dev));
    Guid iid = typeof(IAudioMeterInformation).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 1, IntPtr.Zero, out o));
    return (IAudioMeterInformation)o;
  }
  public static float Peak() { float p; Marshal.ThrowExceptionForHR(M().GetPeakValue(out p)); return p; }
}

public class Vol {
  private static IAudioEndpointVolume Ep() {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 0, out dev));
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 1, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static float Get() { float v; Marshal.ThrowExceptionForHR(Ep().GetMasterVolumeLevelScalar(out v)); return v; }
  public static float Set(float v) {
    if (v < 0f) v = 0f;
    if (v > 1f) v = 1f;
    Guid g = Guid.Empty;
    Marshal.ThrowExceptionForHR(Ep().SetMasterVolumeLevelScalar(v, ref g));
    return Get();
  }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Ep().GetMute(out m)); return m; }
  public static bool SetMute(bool m) { Guid g = Guid.Empty; Marshal.ThrowExceptionForHR(Ep().SetMute(m, ref g)); return GetMute(); }
}
"@

# 必须先切 DPI 感知：否则 GetWindowRect 给的是缩放过的虚拟坐标，截图会错位、还会系统性偏移
[void][WinCtl]::SetThreadDpiAwarenessContext([IntPtr](-4))

# 当前进程是不是管理员 —— 每个 action 都带上，调用方能据此标注「这份数据是少报的」
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$res.admin = $isAdmin

# 抽样估算「全黑」比例：PrintWindow 对某些窗口会返回一张全黑图（不报错），
# 所以「有没有拿到东西」不能只看返回值，得看像素。
function Measure-Dark($b) {
  $dark = 0; $n = 0
  for ($x = 0; $x -lt $b.Width; $x += [Math]::Max(4, [int]($b.Width / 40))) {
    for ($y = 0; $y -lt $b.Height; $y += [Math]::Max(4, [int]($b.Height / 40))) {
      $c = $b.GetPixel($x, $y); $n++
      if (($c.R + $c.G + $c.B) -lt 30) { $dark++ }
    }
  }
  return [Math]::Round(100 * $dark / [Math]::Max(1, $n), 1)
}

# 「这个窗口属于哪个进程」在受限令牌下常常读不到：C# 里的 Process.GetProcessById 抛异常，
# 于是进程名只能给 '?'（2026-10-07 实测：13 个窗口全是 '?'）。
# 这里用 Get-Process 建一张 pid→名字 的表来补 —— 同一台机器上那张表是读得到的。
function Get-PidNames {
  $map = @{}
  try { Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $map[[int]$_.Id] = $_.ProcessName } } catch { }
  return $map
}

function Fill-ProcNames($items, $map) {
  foreach ($it in $items) {
    if (-not $it.Proc -or $it.Proc -eq '?') {
      $n = $map[[int]$it.Pid]
      if ($n) { $it.Proc = $n }
    }
  }
  return $items
}

# 一个窗口是否命中**任意一个**关键词（逗号分隔的那串）。
# 单独抽出来是为了别在嵌套的 Where-Object 里跟 `$_` 打架。
function Test-MatchAny($item, $keywords) {
  foreach ($k in $keywords) {
    if ($item.Title -like "*$k*" -or $item.Proc -like "*$k*" -or $item.Class -like "*$k*") { return $true }
  }
  return $false
}

# 采一段电平（音乐是动态的，单点会落在安静处）—— 用最大值代表「这段里有没有声音」。
# `$ms` 给长一点很有用：QQ音乐 暂停是**淡出**的，量太短会把淡出中的声音当成"还在放"（2026-10-07 真踩过）。
function Measure-Peak([int]$ms = 720) {
  $max = 0.0
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) {
    try { $p = [Meter]::Peak() } catch { return -1 }
    if ($p -gt $max) { $max = $p }
    Start-Sleep -Milliseconds 60
  }
  return [Math]::Round($max, 3)
}

try {
  switch ($Action) {

    'volume-get' {
      $res.ok = $true
      $res.volume = [Math]::Round([Vol]::Get() * 100)
      $res.muted = [Vol]::GetMute()
    }

    'volume-set' {
      $before = [Math]::Round([Vol]::Get() * 100)
      $mutedBefore = [Vol]::GetMute()
      if ($Level -ge 0) { $after = [Math]::Round([Vol]::Set([float]$Level) * 100) } else { $after = $before }
      if ($Mute -eq 'true') { [void][Vol]::SetMute($true) } elseif ($Mute -eq 'false') { [void][Vol]::SetMute($false) }
      $res.ok = $true
      $res.before = $before
      $res.after = $after
      $res.muted = [Vol]::GetMute()
      $res.mutedBefore = $mutedBefore
    }

    'audio-peak' {
      # 「现在到底有没有声音」。**2 秒**采样取最大 —— 单点会被歌的安静段骗到，
      # 但也不能太长：媒体控制里要连量两次，太慢会把整条调用拖到超时。
      $p = Measure-Peak 2000
      $res.ok = $true
      $res.peak = $p
      $res.playing = ($p -ge 0.02)
    }

    'media' {
      # 媒体键是**全局**的：谁在处理媒体键就归谁（浏览器 / 播放器 / 系统）
      #
      # ⚠️ 这里**不能**写 `$vk = switch (...) { ... }` —— 那是 PowerShell 7 的语法（语句当表达式），
      # Windows PowerShell 5.1 直接**解析失败、整个脚本一行都不跑、结果文件也不写**。
      # 而这个脚本在机器人里跑时用的就是 5.1（`resolvePowerShell()` 在沙箱里找不到 pwsh 就退回它）。
      # 2026-10-07 真实翻车：我用手敲的 pwsh 7 验过一切正常，接进机器人却全线失败。
      # **教训：验的时候必须走"生产实际走的那条路"。**
      $map = @{ play_pause = 0xB3; next = 0xB0; prev = 0xB1; stop = 0xB2 }
      if (-not $map.ContainsKey([string]$MediaAction)) { throw "不认识的媒体动作：$MediaAction" }
      [byte]$vk = $map[[string]$MediaAction]
      # 按之前先量一段电平，按完再量 —— 这样能**如实**说出「到底有没有生效」。
      # 按完要**多等一会儿、再量长一点**：QQ音乐 是淡出的，量得短会把淡出当"没停"。
      $before = Measure-Peak 2500
      [WinCtl]::keybd_event($vk, 0, 0, [IntPtr]::Zero)
      [WinCtl]::keybd_event($vk, 0, 2, [IntPtr]::Zero)   # KEYEVENTF_KEYUP
      Start-Sleep -Milliseconds 2500
      $after = Measure-Peak 5000
      $res.ok = $true
      $res.media = $MediaAction
      $res.peakBefore = $before
      $res.peakAfter = $after
      # 本来就没声音（< 0.01）时，前后一样是**正常**的，不能当成"它没响应"
      $res.silentBefore = ($before -ge 0 -and $before -lt 0.01)
      $res.changed = ($before -ge 0 -and $after -ge 0 -and [Math]::Abs($after - $before) -gt 0.02)
    }

    'list-windows' {
      $all = @(Fill-ProcNames ([WinCtl]::Windows() | Where-Object { $_.W -gt 80 -and $_.Hh -gt 80 }) (Get-PidNames))
      $res.ok = $true
      $res.windows = @($all | Sort-Object -Property @{ Expression = { $_.W * $_.Hh }; Descending = $true } |
        Select-Object -First 30 | ForEach-Object {
          @{ title = $_.Title; proc = $_.Proc; pid = $_.Pid; w = $_.W; h = $_.Hh; min = $_.Min }
        })
    }

    'screenshot' {
      if (-not $Match) { throw '必须给 -Match（窗口标题或进程名的一部分）' }
      if (-not $Out) { throw '必须给 -Out（PNG 输出路径）' }

      $blocked = @()
      if ($Blocklist) { $blocked = $Blocklist.Split(',') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ } }
      # -Match 允许**逗号分隔的多个关键词**（调用方会把「浏览器」这种口语名扩成一串别名再传进来）
      $keywords = @($Match.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })

      $cands = @(Fill-ProcNames ([WinCtl]::Windows() | Where-Object { $_.W -gt 80 -and $_.Hh -gt 80 -and -not $_.Min }) (Get-PidNames))
      $hit = @($cands | Where-Object { Test-MatchAny $_ $keywords })
      if (-not $hit.Count) {
        $res.error = "没找到匹配「$Match」的窗口"
        # 把候选标题带回去，调用方（模型）能自己换个词重试
        $res.candidates = @($cands | Sort-Object -Property @{ Expression = { $_.W * $_.Hh }; Descending = $true } |
          Select-Object -First 12 | ForEach-Object { $_.Title })
        Write-Result
        exit 0
      }
      # 命中多个时挑最大的那个（名单/工具栏之类的小窗口会一起命中）
      $target = $hit | Sort-Object -Property @{ Expression = { $_.W * $_.Hh }; Descending = $true } | Select-Object -First 1

      if ($blocked -contains $target.Proc.ToLower()) {
        $res.error = "「$($target.Proc)」在截图黑名单里，拒绝"
        Write-Result
        exit 0
      }

      Add-Type -AssemblyName System.Drawing
      $w = $target.W; $h = $target.Hh
      $bmp = New-Object System.Drawing.Bitmap($w, $h)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc()
      $pw = [WinCtl]::PrintWindow($target.H, $hdc, 2)
      if (-not $pw) { $pw = [WinCtl]::PrintWindow($target.H, $hdc, 0) }
      $g.ReleaseHdc($hdc)
      $g.Dispose()

      $method = 'printwindow'
      $black = Measure-Dark $bmp

      if (-not $pw -or $black -gt 95) {
        # 兜底：抓屏 + 按窗口矩形裁剪。**这会把窗口顶到前台**（得跟用户说清楚）
        $bmp.Dispose()
        $method = 'screen-crop'
        [void][WinCtl]::ShowWindow($target.H, 9)     # SW_RESTORE
        [void][WinCtl]::SetForegroundWindow($target.H)
        Start-Sleep -Milliseconds 350
        $r = New-Object WinCtl+RECT
        [void][WinCtl]::GetWindowRect($target.H, [ref]$r)
        $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
        $sw = [WinCtl]::GetSystemMetrics(0); $sh = [WinCtl]::GetSystemMetrics(1)
        $full = New-Object System.Drawing.Bitmap($sw, $sh)
        $gf = [System.Drawing.Graphics]::FromImage($full)
        $gf.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size($sw, $sh)))
        $gf.Dispose()
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $gc = [System.Drawing.Graphics]::FromImage($bmp)
        $gc.DrawImage($full, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)),
          (New-Object System.Drawing.Rectangle($r.Left, $r.Top, $w, $h)), [System.Drawing.GraphicsUnit]::Pixel)
        $gc.Dispose()
        $full.Dispose()
        $black = Measure-Dark $bmp
      }

      $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()

      $res.ok = $true
      $res.title = $target.Title
      $res.proc = $target.Proc
      $res.width = $w
      $res.height = $h
      $res.method = $method
      $res.blackPct = $black
      $res.file = $Out
    }

    'close-window' {
      if (-not $Match) { throw '必须给 -Match' }
      $cands = [WinCtl]::Windows() | Where-Object { $_.W -gt 80 -and $_.Hh -gt 80 }
      $hit = @($cands | Where-Object { $_.Title -like "*$Match*" -or $_.Proc -like "*$Match*" -or $_.Class -like "*$Match*" })
      if (-not $hit.Count) { $res.error = "没找到匹配「$Match」的窗口"; Write-Result; exit 0 }
      $target = $hit | Sort-Object -Property @{ Expression = { $_.W * $_.Hh }; Descending = $true } | Select-Object -First 1
      [void][WinCtl]::Close($target.H)
      $res.ok = $true
      $res.title = $target.Title
      $res.proc = $target.Proc
      $res.pid = $target.Pid
    }

    default { throw "不认识的 action：$Action" }
  }
} catch {
  $res.ok = $false
  $res.error = $_.Exception.Message
}

Write-Result
