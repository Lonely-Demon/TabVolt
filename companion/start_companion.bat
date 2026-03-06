@echo off
title TabVolt Companion
echo ================================================
echo   TabVolt Companion - Hardware Monitor
echo ================================================
echo.
echo Starting companion service on port 9001...
echo Press Ctrl+C to stop.
echo.

cd /d "%~dp0"
tabvolt-companion.exe
pause
