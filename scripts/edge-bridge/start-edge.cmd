@echo off
chcp 65001 >nul
setlocal
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "PROFILE=%LOCALAPPDATA%\DSH-Edge-Bridge\profile"
if not exist "%PROFILE%" mkdir "%PROFILE%"
start "" "%EDGE%" --user-data-dir="%PROFILE%" --load-extension="%~dp0extension" --no-first-run --no-default-browser-check "https://www.douyin.com/"
endlocal
