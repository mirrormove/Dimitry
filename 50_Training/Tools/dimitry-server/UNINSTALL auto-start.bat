@echo off
REM  Removes Dimitry auto-start (both methods). Double-click to run.
schtasks /Delete /TN "DimitryServer" /F >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DimitryServer.vbs" >nul 2>&1
echo.
echo   Dimitry auto-start removed. (The server itself is untouched;
echo   you can still start it manually with start-dimitry.bat.)
echo.
pause
