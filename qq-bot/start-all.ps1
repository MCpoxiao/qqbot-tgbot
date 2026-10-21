# 小笛 · 一键启动
#
# 2026-10-17 用户要求（「把启动脚本的代理和 napcat 去掉」「我现在是用自己的代理」）：
#   · **NapCat 一律不要了** —— 传输层已是 Telegram（整段已删，UAC 提权也去掉 ✓）；
#   · **不替你开代理** —— 只做一件事：7898 已经在听就给机器人设代理环境变量；
#     没在听就一个都不设（以后换软路由就靠这条分支）。
#
# 现在它只做四件事：① 清旧实例 → ② 起机器人 → ③ 起面板 → ④ 开浏览器。

param([switch]$NoBrowser, [switch]$SkipNapCat)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeExe = $null

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Step($msg) { Write-Host ''; Write-Host "── $msg " -ForegroundColor Cyan -NoNewline; Write-Host ('─' * [Math]::Max(0, 46 - $msg.Length)) -ForegroundColor DarkGray }

# ---------- 传输层：确认是 Telegram（2026-10-17 简化）----------
# 历史：2026-10-14 这段是「TG 模式自动跳过 NapCat」的开关（位置踩过一次坑：PowerShell 从上往下执行，
# 必须放在 Say/Step/$here 定义之后 ✗）。**2026-10-17 起 NapCat 整段已删** ⇒ 没有"跳不跳"的问题了 ✓，
# 这里只剩一句**确认**：读 config.json 的 transport 打印出来，读不到就提示（不影响启动 ✓）。
$transport = ''
try {
  $cfgPath = Join-Path $here 'config.json'
  if (Test-Path $cfgPath) {
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.transport) { $transport = [string]$cfg.transport }
  }
} catch {
  Say "  ⚠️ 读 config.json 失败（不影响启动）：$($_.Exception.Message)" 'Yellow'
}
if ($transport -eq 'telegram') {
  Step '传输层：Telegram'
  Say '  config.json 里 transport=telegram ✓（不需要 QQ / NapCat）' 'Green'
} else {
  Step '传输层'
  Say "  config.json 里 transport = '$transport' —— 本脚本只负责起机器人 ✓（QQ 模式需要你自己开 NapCat）" 'Yellow'
}

function Test-Port([int]$Port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $Port)
    $c.Close()
    return $true
  } catch { return $false }
}

function Resolve-Node {
  $candidates = @(
    $env:DSH_NODE,
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw '找不到 node.exe —— 请把它的完整路径设进环境变量 DSH_NODE'
}

function Get-PanelPids {
  # 提权环境下 CIM 能读到命令行，按脚本名精确匹配
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -like '*panel-server.mjs*' } |
      Select-Object -ExpandProperty ProcessId
  } catch { @() }
}

function Get-ScriptPids {
  # 按**命令行**认出我们自己的那几个 node（机器人 / 面板）。
  #
  # 为什么需要它：原来的僵尸识别只看"谁连着 3001"。可一旦 NapCat 挂了，
  # **所有**僵尸机器人都连不上 3001，于是它们一个都认不出来、清不掉，
  # 等 NapCat 回来就变成同一条消息被回复多次（2026-10-06 真实踩过）。
  # 按命令行认就不受这个影响。只匹配 node.exe，绝不碰 QQ。
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object {
        $_.CommandLine -like '*bot.mjs*' -or
        $_.CommandLine -like '*panel-server.mjs*' 
      } |
      Select-Object -ExpandProperty ProcessId
  } catch { @() }
}

Write-Host ''
Write-Host '  ============================================' -ForegroundColor Magenta
Write-Host '        小笛 · 一键启动' -ForegroundColor Magenta
Write-Host '  ============================================' -ForegroundColor Magenta

try { $nodeExe = Resolve-Node } catch { Say $_.Exception.Message 'Red'; Read-Host '按回车退出'; exit 1 }
Say "node      : $nodeExe"
Say "工作目录  : $here"

# ---------- 1. 清僵尸 ----------
Step '清理旧实例'
# 两条路一起用：
#   只看**命令行**（按脚本名认 bot.mjs / panel-server.mjs）—— 不再依赖 3001（NapCat 已不用）。
# 取并集，且只对 node.exe 下手。
$stale = @(Get-ScriptPids) | Sort-Object -Unique
if ($stale.Count) {
  foreach ($p in $stale) { Say "  停掉旧实例 PID=$p" 'Yellow'; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
} else { Say '  没有残留的实例' 'DarkGray' }

$panels = @(Get-PanelPids) | Where-Object { $stale -notcontains $_ }
if ($panels.Count) {
  foreach ($p in $panels) { Say "  停掉旧面板 PID=$p" 'Yellow'; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}

# 清掉可能残留的锁（僵尸被杀后锁文件不会自己消失）
$lock = Join-Path $here 'logs\bot.lock'
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }

# ---------- 1.5 代理：**不替你开**（2026-10-17 用户要求）----------
#
# 为什么必须放在**起机器人之前**：Node 的 fetch 在**启动时**就固定了代理设置 ——
# 运行时再设 process.env.HTTP_PROXY **无效**（2026-10-09 实测）。
#
# ⚠️ 2026-10-17 改（用户：「代理和 napcat 去掉，代理我自己开」「我后面直接用软路由代理」
#   + 「你还要考虑我忘记开代理且没软路由的情况啊」）：
#   · **不主动启动代理**（那是用户自己的事）；但**必须把"没代理"这种情况说到明处** ✗，
#     否则机器人静默直连、连不上 Telegram，而屏幕上什么都看不出来 ✓。
#   · 判据**不只看端口在听**，而是**真的连一次 api.telegram.org**（端口在听也可能是卡死的内核 ✓）。
#   · ⚠️ NO_PROXY 必须排除本机（2026-10-10 实测：不排除会让本地 ws 一直 1006）。
#
# 四分支：
#   7898 在听 + 经它连得通   → 设环境变量 ✓（本地 mihomo ✓）
#   7898 在听 + 经它连不通   → 警告"代理卡死"，提示重启 mihomo（不擅自重启 ✓）
#   7898 没听 + 直连连得通   → 不设变量 ✓（以后软路由就是这条 ✓）
#   7898 没听 + 直连连不通   → **"既没代理也没路由"** → 大声说明后果 + 问一句要不要帮忙开 ✓
#                              （回车=开 ✓；10 秒没按键自动跳过 ⇒ 开机自启不会卡住 ✓）

function Test-TgReachable([int]$UseProxyPort = 0) {
  # 判据：**拿到任何 HTTP 响应**就算通（api.telegram.org 的 / 返回 404 —— 有响应就说明路由可达 ✓）。
  # 只认 5 秒内出结果；超时/异常都算不通 ✓。
  try {
    $arg = @{
      Uri = 'https://api.telegram.org/'
      TimeoutSec = 5
      UseBasicParsing = $true
      ErrorAction = 'Stop'
    }
    if ($UseProxyPort -gt 0) { $arg['Proxy'] = "http://127.0.0.1:$UseProxyPort" } else { $arg['NoProxy'] = $true }
    Invoke-WebRequest @arg | Out-Null
    return $true
  } catch {
    # 「有响应但状态码不对」也算通（WebException 里带着 Response 就说明连上了 ✓）
    if ($_.Exception.Response) { return $true }
    return $false
  }
}

function Read-ChoiceWithTimeout([int]$Seconds = 10) {
  # 回车=是 ✓；10 秒无按键=否 ✓（不能让它把开机自启卡住 ✗）
  $deadline = (Get-Date).AddSeconds($Seconds)
  $key = "no"
  while ((Get-Date) -lt $deadline) {
    if ([Console]::KeyAvailable) {
      $k = [Console]::ReadKey($true)
      if ($k.Key -eq 'Enter') { $key = 'yes' }
      break
    }
    Start-Sleep -Milliseconds 120
  }
  return $key
}

$proxyPort = 7898
$proxyOk = $false
if (Test-Port $proxyPort) {
  # ⚠️ 2026-10-17 晚修正（用户重启后仍然 `fetch failed` ✗ —— 是我这段逻辑写错了）：
  #   **只要 7898 在听，就必须给机器人设代理变量** ✓✓ —— 因为**这是它唯一能到 Telegram 的路** ✓：
  #   拿掉变量 = 直连 = **永远连不上** ✗（那时候警告写得再响也没用 ✓）。
  #   所以 TCP 检查变成**唯一门槛** ✓，TG 的连通性检查**降级为"只告警"** ✓：
  #   通了 → 绿字 ✓；不通 → 黄字警告（可能只是当前节点坏了 ✓，mihomo 的 自动-TG/fallback 会自己换 ✓）。
  #   ⚠️ 另记一笔：这个文件里**绝不能**写 /** */ 那种注释 ✗ —— 那是 JS 的，PowerShell 当场解析失败 ✓
  #      （我今晚在这上面栽了两次 ✗，别再来第三次）。
  $proxyOk = $true
  Say "  ✅ 本地代理 127.0.0.1:$proxyPort 在听 → **给机器人设代理环境变量** ✓" 'Green'
  if (Test-TgReachable $proxyPort) {
    Say '     经它连 api.telegram.org 通过 ✓' 'Gray'
  } else {
    Say '     ⚠️ 经它暂时连不上 api.telegram.org —— **但变量照设** ✓' 'Yellow'
    Say '        （可能只是当前节点坏了：mihomo 的「自动-TG」组会自己换节点 ✓；也可能要重启一次 mihomo）' 'DarkGray'
  }
} else {
  Say '  · 没检测到本地代理（7898）' 'DarkGray'
  if (Test-TgReachable) {
    Say '  ✅ 但**直连**能到 api.telegram.org ⇒ 按"软路由/系统级代理"处理，不设代理环境变量 ✓' 'Green'
  } else {
    # ←← 用户特意要求补上的情况：忘记开代理、也还没有软路由
    Say '' 
    Say '  ⚠️⚠️ **既没开代理，也没有软路由** —— 机器人将**连不上 Telegram**（会一直重试，但不会成功）' 'Red'
    Say '     现在开一个还来得及：回车 = 我帮你跑一次 D:\mihomo\启动代理.ps1' 'Yellow'
    Say '     （10 秒不按键就跳过，先把机器人起起来；之后你自己开了代理，**再跑一次本脚本**即可）' 'DarkGray'
    $choice = Read-ChoiceWithTimeout 10
    if ($choice -eq 'yes') {
      $starter = 'D:\mihomo\启动代理.ps1'
      if (Test-Path $starter) {
        Say '  → 正在启动 mihomo…' 'Yellow'
        try { & $starter | Out-Null } catch { Say "     启动报错：$($_.Exception.Message)" 'Red' }
        Start-Sleep -Seconds 2
        if ((Test-Port $proxyPort) -and (Test-TgReachable $proxyPort)) {
          $proxyOk = $true
          Say '  ✅ 代理起来了，且经它连得通 ✓' 'Green'
        } else {
          Say '  ⚠️ 代理还是不通（看它自己的窗口报了什么）—— 机器人照常起，等你修好再跑一次本脚本' 'Yellow'
        }
      } else {
        Say "  ⚠️ 找不到 $starter" 'Red'
      }
    } else {
      Say '  · 已跳过。**注意**：机器人这次会连不上 Telegram ✓（不是它坏了 ✗）' 'Yellow'
      Say '    ⇒ 开好代理后，**必须再跑一次本脚本**（代理变量是启动时固定的，热改没用 ✗）' 'Yellow'
    }
  }
}

if ($proxyOk) {
  $env:NODE_USE_ENV_PROXY = '1'
  $env:HTTP_PROXY = "http://127.0.0.1:$proxyPort"
  $env:HTTPS_PROXY = "http://127.0.0.1:$proxyPort"
  $env:NO_PROXY = '127.0.0.1,localhost,::1'
  Say "  → 已给机器人设代理环境变量 127.0.0.1:$proxyPort（NO_PROXY 排除本机 ✓）" 'Gray'
} else {
  # 明确清掉，避免同一窗口里上一轮的环境变量残留（不然会去连一个死端口 ✗）
  Remove-Item Env:NODE_USE_ENV_PROXY, Env:HTTP_PROXY, Env:HTTPS_PROXY -ErrorAction SilentlyContinue
  Say '  → 这次**不设代理环境变量**（机器人走直连）' 'Gray'
}


# ---------- 2. 机器人 + 面板 ----------
# 2026-10-17：传输层已经换到 Telegram，脚本里**不再管 NapCat**（NapCat 整段已删）——
# 机器人自己会连 Telegram；面板是本机 HTTP 服务，两者互不依赖。
Step '机器人主体'
Start-Process -FilePath $nodeExe -WorkingDirectory $here -ArgumentList 'bot.mjs' | Out-Null
Start-Sleep -Seconds 4
Say '  已在新窗口启动（那个窗口关掉 = 机器人下线）'

Step '控制面板'
Start-Process -FilePath $nodeExe -WorkingDirectory $here -ArgumentList 'tools\panel-server.mjs' | Out-Null
Start-Sleep -Seconds 3
if (Test-Port 6182) { Say '  ✅ http://127.0.0.1:6182/' 'Green' } else { Say '  ⚠️ 6182 没起来，看看它的窗口报了什么' 'Yellow' }

# ---------- 4. 浏览器 ----------
if (-not $NoBrowser -and (Test-Port 6182)) {
  Start-Process 'http://127.0.0.1:6182/' | Out-Null
}

Write-Host ''
Say '全部启动完成。' 'Green'
Say '  控制面板  http://127.0.0.1:6182/'
Say ''
Say '要全部停掉，双击桌面上的「停掉小笛.cmd」。' 'DarkGray'
Write-Host ''
Read-Host '按回车关闭本窗口（不影响已启动的服务）'


