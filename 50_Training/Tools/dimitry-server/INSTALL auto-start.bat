@echo off
REM ==========================================================
REM  Makes Dimitry start automatically every time you log in.
REM  Double-click this file once. No admin needed.
REM  Tries Task Scheduler first; falls back to the Startup folder.
REM ==========================================================
setlocal
set HERE=%~dp0
set TASK=DimitryServer
set VBS=%HERE%run-hidden.vbs

echo.
echo   Installing Dimitry auto-start...
echo.

REM --- Attempt 1: Windows Task Scheduler (runs at logon) ---
schtasks /Create /TN "%TASK%" /TR "wscript.exe \"%VBS%\"" /SC ONLOGON /F >nul 2>&1
if %errorlevel%==0 (
  echo   [OK] Registered as a scheduled task "%TASK%".
  goto done
)

REM --- Attempt 2: Startup folder (no admin, always works) ---
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
copy /Y "%VBS%" "%STARTUP%\DimitryServer.vbs" >nul 2>&1
if %errorlevel%==0 (
  echo   [OK] Added to your Startup folder.
) else (
  echo   [X] Could not install automatically. Tell Dimitry what error you saw.
  goto end
)

:done
echo.
echo   Done. Dimitry will start quietly whenever you log in.
echo   Starting it now so you don't have to log out first...
start "" wscript.exe "%VBS%"
timeout /t 2 >nul
echo.
echo   Open  http://localhost:8848  to confirm it's running.
:end
echo.
pause
