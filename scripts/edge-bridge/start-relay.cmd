@echo off
chcp 65001 >nul
cd /d "%~dp0"
set BRIDGE_PORT=8788
node relay.mjs
pause
