# 停止本项目启动的浏览器桥接 relay（按命令行识别，不影响其它 node 进程）
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -match 'edge-bridge[\\/]relay\.mjs|chrome-bridge[\\/]relay\.mjs'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host '已停止浏览器桥接 relay。'
