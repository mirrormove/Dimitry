@echo off
REM ==========================================================
REM  Repairs the Dimitry auto-start that errored at login
REM  (Windows Script Host code 80070002 - "cannot find the file").
REM  Cause: the old Startup shortcut looked for start-dimitry.bat
REM  inside the Startup folder. This installs the corrected launcher
REM  (absolute path baked in) and starts the server now.
REM  Double-click this file once. No admin needed.
REM ==========================================================
setlocal
set HERE=%~dp0
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

echo.
echo   Repairing Dimitry auto-start...
echo.

REM 1) remove the broken entries (old Startup copy + any scheduled task)
del "%STARTUP%\DimitryServer.vbs" >nul 2>&1
schtasks /Delete /TN "DimitryServer" /F >nul 2>&1

REM 2) install the CORRECTED hidden launcher
copy /Y "%HERE%run-hidden.vbs" "%STARTUP%\DimitryServer.vbs" >nul
if %errorlevel%==0 (
  echo   [OK] Corrected launcher installed to your Startup folder.
) else (
  echo   [X] Could not write to the Startup folder. Tell Dimitry the error.
  goto end
)

REM 3) start it now so you don't have to log out
echo   Starting the server now...
start "" wscript.exe "%STARTUP%\DimitryServer.vbs"
timeout /t 2 >nul
echo.
echo   Done. The login error will not appear again.
echo   Confirm it is running: open  http://localhost:8848
:end
echo.
pause
