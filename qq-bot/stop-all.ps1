<#
.SYNOPSIS
把 小笛 相关的进程全部停掉：机器人、控制面板、二维码看板、NapCat 与它拉起的 QQ。

.DESCRIPTION
**必须按 PID 精确停**——只关外层窗口不会杀掉子进程，那正是之前攒出
5 个僵尸机器人、同一条消息被回复多次的原因。

它只杀：
  - 连着 3001 的 node 进程（机器人）
  - 命令行里含 panel-server.mjs / qr-server.mjs 的 node 进程
  - NapCatWinBootMain 与它带起来的 QQ
它**不碰**你自己正常开的 QQ —— 但注意 QQ 进程名一样，
所以这里用"是否为 NapCat 启动的"来区分：先杀 NapCatWinBootMain，再确认 QQ 是否随之退出。
#>

[CmdletBinding()]
param([switch]$KeepNapCat, [switch]$Quiet)

$ErrorActionPreference = 'Continue'
$stopped = @()

# ---- 权限自检 ----
# 下面要靠 CIM 读命令行来精确识别"面板 / 二维码看板"，并用 ParentProcessId
# 认出哪些 QQ 是 NapCat 拉起的。**非提权时 CIM 常读不到**（实测 IsInRole(Admin)=False
# 时 Get-CimInstance 直接失败），结果就是"停不干净"——面板还留着。
# 所以跟 start-all 一样自检、必要时提权。
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '需要管理员权限（要读进程命令行来精确识别，不然会停不干净），正在提权…' -ForegroundColor Yellow
  # **必须用 pwsh**：powershell.exe 的 `-Verb RunAs` 实测会悄悄失败（返回 PID 但什么都没跑）。
  $pwshExe = "$env:LOCALAPPDATA\Microsoft\WindowsApps\pwsh.exe"
  if (-not (Test-Path $pwshExe)) {
    $g = Get-Command pwsh -ErrorAction SilentlyContinue
    $pwshExe = if ($g) { $g.Source } else { 'powershell.exe' }
  }
  Start-Process -FilePath $pwshExe -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
  ) -Verb RunAs
  exit
}

function Say($m, $c = 'Gray') { if (-not $Quiet) { Write-Host $m -ForegroundColor $c } }

function Stop-IfRunning($proc, $label) {
  if ($proc) {
    foreach ($p in @($proc)) {
      Say "  停掉 $label (PID $($p.Id))" 'Yellow'
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      $script:stopped += $label
    }
  }
}

function Get-NodePidsByCommand([string]$pattern) {
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -like "*$pattern*" } |
      Select-Object -ExpandProperty ProcessId
  } catch { @() }
}

Write-Host ''
Write-Host '  小笛 · 全部停止' -ForegroundColor Magenta

# 1) 机器人：连着 3001 的 node
$botPids = netstat -ano |
  Select-String '127\.0\.0\.1:3001\s+.*ESTABLISHED' |
  ForEach-Object { ($_.Line.Trim() -split '\s+')[-1] } |
  Sort-Object -Unique
foreach ($p in $botPids) {
  $proc = Get-Process -Id ([int]$p) -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') { Stop-IfRunning $proc '机器人' }
}

# 2) 面板与二维码看板
foreach ($pat in 'panel-server.mjs', 'qr-server.mjs') {
  foreach ($id in Get-NodePidsByCommand $pat) {
    Stop-IfRunning (Get-Process -Id $id -ErrorAction SilentlyContinue) $pat
  }
}

# 3) 锁文件
$lock = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'logs\bot.lock'
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Say '  清掉单实例锁' 'DarkGray' }

# 4) NapCat 与它拉起的 QQ
if ($KeepNapCat) {
  Say '  按参数要求保留 NapCat' 'DarkGray'
} else {
  $boot = Get-Process -Name NapCatWinBootMain -ErrorAction SilentlyContinue
  if ($boot) {
    # ⚠️ **不能直接 `Get-Process -Name QQ`**：NapCat 拉起的 QQ 和你自己开的大号 QQ
    # 进程名一模一样，那样会把你自己正在用的 QQ 一起杀掉。
    # 先在杀 NapCat **之前**认亲（用 ParentProcessId），再只杀认出来的那几个。
    $bootIds = @($boot | ForEach-Object { $_.Id })
    $myQq = @()
    try {
      $myQq = @(
        Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction Stop |
          Where-Object { $bootIds -contains [int]$_.ParentProcessId } |
          Select-Object -ExpandProperty ProcessId
      )
    } catch { $myQq = @() }

    Stop-IfRunning $boot 'NapCatWinBootMain'
    Start-Sleep -Seconds 4

    if ($myQq.Count) {
      foreach ($id in $myQq) {
        Stop-IfRunning (Get-Process -Id $id -ErrorAction SilentlyContinue) 'NapCat 拉起的 QQ'
      }
    } else {
      Say '  认不出哪些 QQ 是 NapCat 拉起的 —— **不动任何 QQ 进程**（避免误杀你自己开的）' 'DarkGray'
      Say '  如果它还在后台，去任务管理器手动结束那个 QQ 即可。' 'DarkGray'
    }
  } else {
    Say '  NapCat 没在跑' 'DarkGray'
  }
}

Write-Host ''
if ($stopped.Count) { Say "已停止 $($stopped.Count) 个进程。" 'Green' } else { Say '本来就没有在跑的东西。' 'DarkGray' }
Say '你桌面上的文件一个都没动。' 'DarkGray'
Write-Host ''
if (-not $Quiet) { Read-Host '按回车关闭' }
