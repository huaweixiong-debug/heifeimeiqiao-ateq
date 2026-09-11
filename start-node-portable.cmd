@echo off
setlocal
cd /d "%~dp0"

rem Portable Node launcher used by start.cmd.
rem Uses the local portable Node.js install; falls back to node in PATH.

set "NODE_EXE="
if exist "D:\ATEQ\nodejs\node.exe" set "NODE_EXE=D:\ATEQ\nodejs\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%p in ('where node 2^>nul') do (
    set "NODE_EXE=%%p"
    goto :found_node
  )
)
:found_node
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Expected D:\ATEQ\nodejs\node.exe or node in PATH.
  exit /b 1
)

echo [INFO] Starting ATEQ server: "%NODE_EXE%" server.js
"%NODE_EXE%" server.js 1> "%~dp0server.out" 2> "%~dp0server.err"
set "RUN_EXIT=%ERRORLEVEL%"
echo [ERROR] server exited with code %RUN_EXIT%. See server.out / server.err.
exit /b %RUN_EXIT%
