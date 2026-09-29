@echo off
setlocal
cd /d "%~dp0"

echo.
echo   Repair the Electron desktop helper used by plugins like dsh-pet
echo   =============================================================
echo.
echo   Run this when a desktop window (the pet) stops appearing.
echo   It checks the helper the way Electron needs it, not the way the
echo   plugin's own "is it installed?" check does, and reinstalls it if broken.
echo.
echo   DSH Desktop may stay open; only the helper itself must not be running.
echo.

node "scripts\repair-electron-helper.mjs" %*
if errorlevel 1 (
  echo.
  echo   Repair did not finish. Read the messages above.
)

echo.
pause
