@echo off
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js isn't installed.
  echo Get it free at https://nodejs.org (choose the LTS version), then double-click this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Setting up (first run only, this takes a minute or two)...
  call npm install
)

if not exist .env (
  node setup.js
)

echo.
echo Starting KinRead...
echo Your browser will open to http://localhost:3000 in a few seconds.
start "" cmd /c "timeout /t 2 >nul && start http://localhost:3000"
call npm start
