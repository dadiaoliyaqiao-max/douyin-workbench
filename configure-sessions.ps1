#requires -Version 5.1
<#
  可选高级步骤：绑定 5 个 DSH 会话，启用五模块工作台自动派工。

  运行前提：
    1. 已运行 install.ps1；
    2. 已在 DSH 里创建 6 个工作聊天：1 个总管 + 5 个模块会话；
    3. 能拿到每个聊天的会话 ID（session-xxxxxxxx-...）。

  如果不确定会话 ID：先跳过本步骤。你仍然可以按教程手动在 5 个聊天里操作，
  浏览器桥接、规则、报告文件和全部命令都不受影响。
#>
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Read-SessionId([string]$label) {
  while ($true) {
    $value = Read-Host "$label 的会话 ID（留空=放弃绑定）"
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    $value = $value.Trim()
    if ($value -match '^session-[a-z0-9][a-z0-9_-]{3,}$') { return $value }
    Write-Host "  格式不对，应以 session- 开头，例如 session-1a2b3c4d-...." -ForegroundColor Yellow
  }
}

Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  绑定 5 个 DSH 会话（可选）' -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '提示：在 DSH 每个聊天里可查看会话信息；不知道 ID 就直接回车放弃。'

$controller = Read-SessionId '总管'
if (-not $controller) { Write-Host '已放弃：未绑定会话。工作台保持关闭，手动模式仍可正常使用。' -ForegroundColor Yellow; exit 0 }
$s1 = Read-SessionId '会话1 对标账号'
$s2 = Read-SessionId '会话2 参考视频'
$s3 = Read-SessionId '会话3 原创剧本'
$s4 = Read-SessionId '会话4 自有账号复盘'
$s5 = Read-SessionId '会话5 规则与增长情报'
if (-not ($s1 -and $s2 -and $s3 -and $s4 -and $s5)) { Write-Host '有会话 ID 为空，已放弃。' -ForegroundColor Yellow; exit 0 }

$installSlash = $root.Replace('\', '/')
$now = (Get-Date).ToString('o')
$map = [ordered]@{
  '{{CONTROLLER_SESSION_ID}}' = $controller
  '{{SESSION1_ID}}' = $s1
  '{{SESSION2_ID}}' = $s2
  '{{SESSION3_ID}}' = $s3
  '{{SESSION4_ID}}' = $s4
  '{{SESSION5_ID}}' = $s5
}

# 1) 替换插件代码里的会话占位符
$targets = @(
  (Join-Path $root 'scripts\session-dispatch\core-v3.mjs'),
  (Join-Path $root 'scripts\sidebar-dashboard\client.mjs'),
  (Join-Path $root 'scripts\sidebar-dashboard\lib\client.js')
)
foreach ($file in $targets) {
  if (-not (Test-Path $file)) { continue }
  $t = Get-Content -LiteralPath $file -Raw -Encoding UTF8
  foreach ($k in $map.Keys) { $t = $t.Replace($k, $map[$k]) }
  Set-Content -LiteralPath $file -Value $t -Encoding UTF8 -NoNewline
  Write-Host "  已写入：$file" -ForegroundColor Green
}

# 2) 生成调度配置
$tplPath = Join-Path $root 'config\session-dispatch.template.json'
$cfg = Get-Content -LiteralPath $tplPath -Raw -Encoding UTF8
foreach ($k in $map.Keys) { $cfg = $cfg.Replace($k, $map[$k]) }
$cfg = $cfg.Replace('{{INSTALL_DIR}}', $installSlash).Replace('{{CONFIGURED_AT}}', $now)
Set-Content -LiteralPath (Join-Path $root 'config\session-dispatch-v3.json') -Value $cfg -Encoding UTF8 -NoNewline
Write-Host '  已生成：config\session-dispatch-v3.json' -ForegroundColor Green

# 3) 启用 DSH 插件行
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
if (Test-Path $patch) {
  $backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $patch $backup -Force
  $text = Get-Content -LiteralPath $patch -Raw -Encoding UTF8
  $text = [regex]::Replace($text, '(?s)(id:\s*douyin-workbench.*?disabled:\s*)true', '${1}false')
  Set-Content -LiteralPath $patch -Value $text -Encoding UTF8 -NoNewline
  Write-Host '  已启用 DSH 插件配置（disabled: false）' -ForegroundColor Green
} else {
  Write-Host '  未找到 cordis.patch.yml：请先启动一次 DSH 再重跑本脚本。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '绑定完成！请完全退出并重新启动 DSH（不是刷新页面），' -ForegroundColor Cyan
Write-Host '重新打开“总管”聊天，右侧应出现【五模块工作台】。' -ForegroundColor Cyan
