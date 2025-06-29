@echo off
chcp 65001 >nul
title Extension Setup

echo 🚀 Chrome Extension Setup
echo =========================
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js not found! 
    echo Please install from: https://nodejs.org/
    pause
    exit /b 1
) else (
    for /f "tokens=*" %%i in ('node --version') do set node_version=%%i
    echo ✅ Node.js: %node_version%
)

:: Install obfuscator
echo 📦 Installing javascript-obfuscator...
call npm install -g javascript-obfuscator
if %errorlevel% neq 0 (
    echo ❌ Failed to install. Try running as Administrator.
    pause
    exit /b 1
)

:: Verify
call javascript-obfuscator --version >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%i in ('javascript-obfuscator --version') do set obf_version=%%i
    echo ✅ javascript-obfuscator: %obf_version%
) else (
    echo ❌ Installation failed
    pause
    exit /b 1
)

:: Create folders
if not exist build mkdir build

echo.
echo ✅ Setup completed!
echo.
echo Next: Run build.bat to build your extension
echo.
pause