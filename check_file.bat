@echo off
chcp 65001 >nul
title File Checker

echo 🔍 Extension Files Checker
echo ==========================
echo.

echo Checking required files:
echo.

:: Check each file
if exist manifest.json (
    echo ✅ manifest.json - Found
    for /f "tokens=2 delims=:" %%a in ('findstr /r "version" manifest.json') do set version=%%a
    set version=%version:"=%
    set version=%version: =%
    set version=%version:,=%
    if not "%version%"=="" echo    📋 Version: %version%
) else (
    echo ❌ manifest.json - MISSING
)

if exist background.js (
    echo ✅ background.js - Found
    for %%A in (background.js) do echo    📊 Size: %%~zA bytes
) else (
    echo ❌ background.js - MISSING
)

if exist popup.html (
    echo ✅ popup.html - Found
) else (
    echo ❌ popup.html - MISSING  
)

if exist popup.js (
    echo ✅ popup.js - Found
    for %%A in (popup.js) do echo    📊 Size: %%~zA bytes
) else (
    echo ❌ popup.js - MISSING
)

if exist styles.css (
    echo ✅ styles.css - Found
    for %%A in (styles.css) do echo    📊 Size: %%~zA bytes
) else (
    echo ❌ styles.css - MISSING
)

echo.
echo Checking optional files:
echo.

if exist images (
    echo ✅ images folder - Found
    if exist images\*.png (
        echo    📁 PNG files found
    ) else (
        echo    ⚠️  No PNG icons found
    )
) else (
    echo ⚠️  images folder - Missing
)

echo.
echo Development tools:
echo.

node --version >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%i in ('node --version') do echo ✅ Node.js: %%i
) else (
    echo ❌ Node.js - Not installed
)

call javascript-obfuscator --version >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%i in ('javascript-obfuscator --version') do echo ✅ Obfuscator: %%i
) else (
    echo ❌ javascript-obfuscator - Not installed
)

echo.
echo ==========================================

:: Count missing files
set missing=0
if not exist manifest.json set /a missing+=1
if not exist background.js set /a missing+=1  
if not exist popup.html set /a missing+=1
if not exist popup.js set /a missing+=1
if not exist styles.css set /a missing+=1

if %missing% equ 0 (
    echo 🎉 All required files present!
    echo ✅ Ready to build extension
    echo.
    echo Run: build.bat
) else (
    echo ❌ %missing% required files missing
    echo Please add missing files before building
)

echo.
pause