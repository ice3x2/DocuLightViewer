@echo off
REM DocuLight Build Script (Windows)
REM Usage: build.bat [win|linux|all]
REM Output: dist/

set TARGET=%1
if "%TARGET%"=="" set TARGET=win

REM Install dependencies if needed
if not exist node_modules (
    echo [DocuLight] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [DocuLight] npm install failed.
        exit /b 1
    )
)

if "%TARGET%"=="win" goto build_win
if "%TARGET%"=="linux" goto build_linux
if "%TARGET%"=="all" goto build_all
echo [DocuLight] Unknown target: %TARGET%
echo Usage: build.bat [win^|linux^|all]
exit /b 1

:build_win
echo [DocuLight] Building for Windows...
call npm run build:win
if errorlevel 1 (
    echo [DocuLight] Windows build failed.
    exit /b 1
)
echo [DocuLight] Windows build complete. Output: dist/
goto end

:build_linux
echo [DocuLight] Building for Linux...
call npm run build:linux
if errorlevel 1 (
    echo [DocuLight] Linux build failed.
    exit /b 1
)
echo [DocuLight] Linux build complete. Output: dist/
goto end

:build_all
echo [DocuLight] Building for Windows + Linux...
call npm run build:win
if errorlevel 1 (
    echo [DocuLight] Windows build failed.
    exit /b 1
)
call npm run build:linux
if errorlevel 1 (
    echo [DocuLight] Linux build failed.
    exit /b 1
)
echo [DocuLight] All builds complete. Output: dist/
goto end

:end
