@echo off
setlocal
cd /d "%~dp0"

echo.
echo   dsh-plugin-doctor -- install into the DSH web profile
echo   =====================================================
echo.
echo   DSH Desktop must be FULLY closed. The market rewrites
echo   dsh.profile.bundles on boot and would race this edit.
echo.
echo   This profile has one known, pre-existing layout error:
echo     D006  dsh-pet is a real directory, not a link
echo   It does not affect loading, so the "already broken" gate is
echo   overridden deliberately rather than silently.
echo.

node "scripts\install-plugin.mjs" --force %*
if errorlevel 1 (
  echo.
  echo   Install did not complete.
  echo   Either the guard rail refused it, or it was rolled back.
  echo   Nothing is left half-applied: the script restores its backup.
)

echo.
pause
