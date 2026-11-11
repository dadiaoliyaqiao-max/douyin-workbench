#requires -Version 5.1
<#
  抖音五模块工作台 · 一键安装脚本（Windows）

  用法（推荐）：
    右键本文件 -> “使用 PowerShell 运行”；或在本目录打开 PowerShell 执行：
      powershell -ExecutionPolicy Bypass -File .\install.ps1

  可选参数：
    -InstallDir "D:\DouyinWorkbench"   安装到指定目录（默认 %USERPROFILE%\DouyinWorkbench）
    -SkipBrowsers                      不创建浏览器快捷方式、不打开登录页
    -Force                             目录已存在时不询问，直接覆盖代码文件（保留个人数据）
#>
param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE 'DouyinWorkbench'),
  [switch]$SkipBrowsers,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Source = $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Write-Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  [!] $text" -ForegroundColor Yellow }
function Write-Fail($text) { Write-Host "  [X] $text" -ForegroundColor Red }

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  抖音五模块工作台 · 安装向导" -ForegroundColor Cyan
Write-Host "  对标账号 / 参考视频 / 原创剧本 / 复盘 / 情报" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "安装目录：$InstallDir"

# ---------- 1. 系统环境检查 ----------
Write-Step "1/8 检查系统环境"
$os = Get-CimInstance Win32_OperatingSystem
Write-Ok "Windows $($os.Caption) $($os.Version)"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Warn2 "当前不是管理员权限；本安装不强制要求管理员，如遇快捷方式/启动项写入失败，请用管理员重试。" }

# DSH 桌面版（宿主）
$dshProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$dshPatch = Join-Path $dshProfile 'cordis.patch.yml'
$dshRunning = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' -or $_.ProcessName -like '*dsh*' }
if (Test-Path $dshProfile) { Write-Ok "检测到 DSH 桌面版用户配置：$dshProfile" }
else { Write-Warn2 "未检测到 DSH 桌面版配置目录（$dshProfile）。请先安装并至少启动一次 DeepSeek Harness；本脚本会继续安装，但五模块侧栏需要 DSH。" }
if (Test-Path $dshPatch) { Write-Ok "检测到 DSH 插件配置：cordis.patch.yml" } else { Write-Warn2 "暂未发现 cordis.patch.yml，稍后将跳过插件注册，可先启动一次 DSH 再重跑本脚本。" }

# 浏览器
$edgeCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path $_) }
$chromeCandidates = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path $_) }
$edge = $edgeCandidates | Select-Object -First 1
$chrome = $chromeCandidates | Select-Object -First 1
if ($edge) { Write-Ok "Microsoft Edge：$edge" } else { Write-Warn2 "未找到 Microsoft Edge（研究浏览器需要它）。" }
if ($chrome) { Write-Ok "Google Chrome：$chrome" } else { Write-Warn2 "未找到 Google Chrome（运营账号复盘需要它）。" }

# Node（优先用 DSH 自带运行时）
$node = $null
$runtimeRoot = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
if (Test-Path $runtimeRoot) {
  $node = Get-ChildItem -Path $runtimeRoot -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\dependencies\\node\\' } |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $node) { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd) { $node = $cmd.Source } }
if ($node) { Write-Ok "Node.js：$node" } else { Write-Fail "未找到 Node.js。请先安装 DSH 桌面版（自带 Node）或安装 Node.js 20+ 后重试。" }

# Python（优先用 DSH 自带运行时）
$python = $null
if (Test-Path $runtimeRoot) {
  $python = Get-ChildItem -Path $runtimeRoot -Recurse -Filter 'python.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\dependencies\\python\\' } |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $python) { $cmd = Get-Command python -ErrorAction SilentlyContinue; if ($cmd) { $python = $cmd.Source } }
if ($python) { Write-Ok "Python：$python" } else { Write-Warn2 "未找到 Python（批次校验/桥接客户端需要 Python 3.10+）。可安装 Python 后重跑安装。" }

if (-not $node) { throw "缺少 Node.js，无法继续。请先安装 DSH 桌面版。" }

# ---------- 2. 确认安装目录 ----------
Write-Step "2/8 准备安装目录"
if (Test-Path $InstallDir) {
  Write-Warn2 "目录已存在：$InstallDir"
  if (-not $Force) {
    $answer = Read-Host "继续会覆盖程序文件，但会保留你的数据目录（batches/research/reviews 等）。继续吗？(y/N)"
    if ($answer -notmatch '^[Yy]') { Write-Host "已取消。" ; exit 0 }
  }
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$InstallDir = (Resolve-Path $InstallDir).Path
Write-Ok "安装目录：$InstallDir"

# ---------- 3. 复制程序文件 ----------
Write-Step "3/8 复制程序文件"
$excludeDirs = @('browser-profiles', '.git', 'logs')
$rcArgs = @($Source, $InstallDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
foreach ($d in $excludeDirs) { $rcArgs += @('/XD', (Join-Path $Source $d)) }
& robocopy @rcArgs | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) { throw "复制文件失败（robocopy 退出码 $rc）。" }
Write-Ok "程序文件已复制"

# ---------- 4. 替换安装路径占位符 ----------
Write-Step "4/8 写入本机路径"
$slash = $InstallDir.Replace('\', '/')
$textExt = @('.mjs', '.js', '.md', '.json', '.py', '.yml', '.yaml', '.ps1', '.cmd', '.html')
$replaced = 0
Get-ChildItem -Path $InstallDir -Recurse -File |
  Where-Object { $textExt -contains $_.Extension.ToLower() -and $_.FullName -notmatch '\\browser-profiles\\' } |
  ForEach-Object {
    $t = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
    if ($null -eq $t -or -not $t.Contains('{{INSTALL_DIR}}')) { return }
    $t = $t.Replace('{{INSTALL_DIR}}', $slash)
    Set-Content -LiteralPath $_.FullName -Value $t -Encoding UTF8 -NoNewline
    $replaced++
  }
Write-Ok "替换路径占位符：$replaced 个文件"

# ---------- 5. 创建数据目录与默认配置 ----------
Write-Step "5/8 初始化工作区目录与默认配置"
$dirs = @('batches', 'research', 'reviews', 'scripts-output', 'handoffs', 'control', 'browser-profiles', 'logs', 'config', 'data')
foreach ($d in $dirs) { New-Item -ItemType Directory -Path (Join-Path $InstallDir $d) -Force | Out-Null }
$businessTarget = Join-Path $InstallDir 'data\business_profile.json'
if (-not (Test-Path $businessTarget)) {
  Copy-Item (Join-Path $InstallDir 'data\business_profile.template.json') $businessTarget
  Write-Ok "已创建 data\business_profile.json（待用户提供业务信息）"
}
$benchTarget = Join-Path $InstallDir 'data\benchmarks.json'
if (-not (Test-Path $benchTarget)) {
  Copy-Item (Join-Path $InstallDir 'data\benchmarks.empty.json') $benchTarget
  Write-Ok "已创建 data\benchmarks.json（空，等待用户给出对标账号）"
}
$runtime = [ordered]@{
  install_dir = $InstallDir
  node = $node
  python = $python
  edge = $edge
  chrome = $chrome
  installed_at = (Get-Date).ToString('o')
}
$runtime | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $InstallDir 'config\runtime.json') -Encoding UTF8
Write-Ok "已保存运行环境：config\runtime.json"

# ---------- 6. 浏览器快捷方式与扩展 ----------
if (-not $SkipBrowsers) {
  Write-Step "6/8 配置两个浏览器（扩展 + 独立配置目录 + 快捷方式）"
  $edgeProfile = Join-Path $InstallDir 'browser-profiles\edge-research'
  $chromeProfile = Join-Path $InstallDir 'browser-profiles\chrome-ops'
  New-Item -ItemType Directory -Path $edgeProfile, $chromeProfile -Force | Out-Null
  $edgeExt = Join-Path $InstallDir 'extensions\edge-bridge'
  $chromeExt = Join-Path $InstallDir 'extensions\chrome-bridge'
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell

  if ($edge) {
    $lnk = $shell.CreateShortcut((Join-Path $desktop '研究浏览器（Edge 小号）.lnk'))
    $lnk.TargetPath = $edge
    $lnk.Arguments = "--user-data-dir=`"$edgeProfile`" --load-extension=`"$edgeExt`" --no-first-run --no-default-browser-check https://www.douyin.com/user/self"
    $lnk.WorkingDirectory = $InstallDir
    $lnk.IconLocation = "$edge,0"
    $lnk.Description = '研究专用：登录抖音小号，用于会话1/2/5；扩展 DSH Edge Bridge 自动加载'
    $lnk.Save()
    Write-Ok "桌面快捷方式：研究浏览器（Edge 小号）"
  }
  if ($chrome) {
    $lnk = $shell.CreateShortcut((Join-Path $desktop '运营浏览器（Chrome 运营账号）.lnk'))
    $lnk.TargetPath = $chrome
    $lnk.Arguments = "--user-data-dir=`"$chromeProfile`" --load-extension=`"$chromeExt`" --no-first-run --no-default-browser-check https://creator.douyin.com/"
    $lnk.WorkingDirectory = $InstallDir
    $lnk.IconLocation = "$chrome,0"
    $lnk.Description = '运营专用：登录运营账号，用于会话4复盘；扩展 DSH Chrome Bridge 自动加载'
    $lnk.Save()
    Write-Ok "桌面快捷方式：运营浏览器（Chrome 运营账号）"
  }

  # 首次安装直接打开两个浏览器，方便扫码登录
  if (-not $Force) {
    $answer = Read-Host "现在打开两个浏览器去登录吗？(Y/n)"
    if ($answer -eq '' -or $answer -match '^[Yy]') {
      if ($edge) { Start-Process -FilePath $edge -ArgumentList "--user-data-dir=`"$edgeProfile`" --load-extension=`"$edgeExt`" --no-first-run https://www.douyin.com/user/self" }
      Start-Sleep -Seconds 2
      if ($chrome) { Start-Process -FilePath $chrome -ArgumentList "--user-data-dir=`"$chromeProfile`" --load-extension=`"$chromeExt`" --no-first-run https://creator.douyin.com/" }
      Write-Warn2 "请扫码登录：Edge 用研究小号，Chrome 用运营账号。登录完成后回到本窗口按回车继续。"
      Read-Host | Out-Null
    }
  }
} else { Write-Step "6/8 已跳过浏览器配置（-SkipBrowsers）" }

# ---------- 7. 启动桥接服务（开机自启） ----------
Write-Step "7/8 配置浏览器桥接服务（开机自动启动）"
$bin = Join-Path $InstallDir 'bin'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
$startup = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $startup '抖音工作台桥接服务.lnk'))
$lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$bin\start-bridges.ps1`""
$lnk.WorkingDirectory = $InstallDir
$lnk.WindowStyle = 7
$lnk.Description = '启动 Edge(8788)/Chrome(8787) 浏览器桥接 relay'
$lnk.Save()
Write-Ok "已加入启动项：抖音工作台桥接服务（登录 Windows 后自动运行）"
try {
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$bin\start-bridges.ps1`"" -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Write-Ok "桥接服务已尝试启动（端口 8788 / 8787）"
} catch { Write-Warn2 "桥接服务启动失败：$($_.Exception.Message)。可稍后运行 bin\start-bridges.ps1。" }

# ---------- 8. 注册 DSH 侧栏插件（默认关闭，绑定会话后启用） ----------
Write-Step "8/8 注册 DSH 五模块侧栏插件"
if (Test-Path $dshPatch) {
  Copy-Item $dshPatch "$dshPatch.bak-$stamp" -Force
  $patchText = Get-Content -LiteralPath $dshPatch -Raw -Encoding UTF8
  if ($patchText -notmatch 'douyin-workbench') {
    $pluginPath = "$slash/scripts/sidebar-dashboard/combined-entry-v5.mjs"
    $block = @"

# 抖音五模块工作台（install.ps1 自动添加；默认关闭，运行 configure-sessions.ps1 绑定会话后启用）
- insert:
    - id: douyin-workbench
      name: "$pluginPath"
      disabled: true
"@
    Set-Content -LiteralPath $dshPatch -Value ($patchText.TrimEnd() + $block + "`n") -Encoding UTF8 -NoNewline
    Write-Ok "已写入插件配置（disabled: true）"
  } else { Write-Ok "插件配置已存在，未重复写入" }
  Write-Warn2 "五模块侧栏默认关闭。需要自动派工/卡片看报告时，运行 configure-sessions.ps1 绑定 5 个会话后重启 DSH。"
} else {
  Write-Warn2 "未找到 DSH 配置，跳过插件注册。先启动一次 DSH，再重跑本脚本，或按教程手动添加插件配置。"
}

# 打开教程
$tutorial = Join-Path $InstallDir 'tutorial.html'
if (Test-Path $tutorial) { Start-Process $tutorial }

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "  安装目录：$InstallDir" -ForegroundColor Green
Write-Host "  教程：$tutorial" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
Write-Host ""
Write-Host "接下来：" -ForegroundColor Cyan
Write-Host "  1. 在 DSH 里新建 5 个聊天（对标/参考/原创/复盘/情报），当前聊天作为总管。"
Write-Host "  2. 把 会话说明\ 里的启动语分别发给 5 个聊天。"
Write-Host "  3. 在管家/会话1 给出你已有的对标账号名称或主页链接。"
Write-Host "  4. 详细流程见 tutorial.html。"
Write-Host ""
