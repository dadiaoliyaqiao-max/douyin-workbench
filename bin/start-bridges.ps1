# 启动两个本机浏览器桥接 relay：
#   Edge  -> 127.0.0.1:8788（扩展：extensions\edge-bridge）
#   Chrome-> 127.0.0.1:8787（扩展：extensions\chrome-bridge）
# 由启动项调用；也可手动运行本文件。
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $root 'config\runtime.json'
$node = $null
if (Test-Path $runtimePath) { $node = (Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json).node }
if (-not $node -or -not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node) { exit 1 }
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Start-Bridge([int]$port, [string]$relay, [string]$log) {
  $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listening) { return }
  $cmd = "set BRIDGE_PORT=$port && `"$node`" `"$relay`" >> `"$log`" 2>&1"
  Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/c', $cmd -WindowStyle Hidden -WorkingDirectory (Split-Path -Parent $relay) | Out-Null
}

Start-Bridge 8788 (Join-Path $root 'scripts\edge-bridge\relay.mjs') (Join-Path $logDir 'edge-bridge.log')
Start-Bridge 8787 (Join-Path $root 'scripts\chrome-bridge\relay.mjs') (Join-Path $logDir 'chrome-bridge.log')
