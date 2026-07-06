@echo off
setlocal
title ATEQ Test D520
cd /d "%~dp0"

set "HEALTH_URL=http://127.0.0.1:3000/api/health"
set "WEB_URL=http://127.0.0.1:3000/"

echo ============================================
echo   ATEQ Test D520
echo ============================================
echo.

curl -s "%HEALTH_URL%" >nul 2>&1
if not errorlevel 1 goto open_browser

if exist "ATEQ.LeakTest.Web.exe" (
  echo [INFO] Starting packaged C# server...
  start "" "ATEQ.LeakTest.Web.exe"
  goto wait_for_server
)

if exist "start-node-portable.cmd" (
  echo [INFO] Starting portable Node.js server...
  start "" cmd /c ""%~dp0start-node-portable.cmd""
  goto wait_for_server
)

if exist ".runtime\node.exe" if exist "server.js" (
  echo [INFO] Starting portable Node.js server directly...
  start "" cmd /c ""%~dp0.runtime\node.exe" "%~dp0server.js" 1> "%~dp0server.out" 2> "%~dp0server.err"""
  goto wait_for_server
)

echo [ERROR] No supported startup target was found in:
echo         %cd%
echo.
echo Available options expected by this launcher:
echo   1. ATEQ.LeakTest.Web.exe
echo   2. start-node-portable.cmd
echo   3. .runtime\node.exe + server.js
exit /b 1

:wait_for_server
echo [INFO] Waiting for server to be ready...
for /l %%i in (1,1,20) do (
  timeout /t 1 /nobreak >nul
  curl -s "%HEALTH_URL%" >nul 2>&1
  if not errorlevel 1 goto open_browser
)

echo [ERROR] Server did not respond on port 3000.
echo         Check server.out / server.err if using Node.js.
exit /b 1

:open_browser
echo [INFO] Opening browser...
start "" "%WEB_URL%"
echo [OK] Ready.
