@echo off
title TabVolt Companion
echo ================================================
echo   TabVolt Companion - Hardware Monitor
echo ================================================
echo.

cd /d "%~dp0"

if not exist tabvolt-companion.exe (
    echo Companion binary not found - building from source...
    where go >nul 2>nul
    if errorlevel 1 (
        echo.
        echo ERROR: Go is not installed. Install it from https://go.dev/dl/
        echo then re-run this script, or build manually with:
        echo     go build -o tabvolt-companion.exe .
        pause
        exit /b 1
    )
    go build -o tabvolt-companion.exe .
    if errorlevel 1 (
        echo Build failed.
        pause
        exit /b 1
    )
    echo Build complete.
    echo.
)

echo Starting companion service on 127.0.0.1:9001...
echo Press Ctrl+C to stop.
echo.

tabvolt-companion.exe
pause
