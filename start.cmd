@echo off
rem Double-click this to open the photo studio. It installs whatever is missing on first run.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. The error message above explains why.
  pause
)
endlocal
