@echo off
REM ==========================================================
REM  DIMITRY · Step 1 — watcher graduation replay
REM
REM  1. Fetches and caches real BTC klines (Binance)
REM  2. Replays them bar-by-bar through the Structure + Level watchers
REM  3. Scores against the frozen Calibration Benchmark
REM  4. Writes replay-report.md + replay-report.json into 50_Training\Tools
REM
REM  Double-click this file. Takes ~1-2 minutes.
REM ==========================================================
setlocal
cd /d "%~dp0"

echo.
echo   ================================================
echo    DIMITRY - WATCHER GRADUATION REPLAY
echo   ================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   [X] Node.js is not on your PATH.
  echo       Install from https://nodejs.org then re-run this file.
  goto end
)

echo   [1/2] Fetching real klines from Binance...
echo.
node replay\fetch-klines.js btc
if errorlevel 1 (
  echo.
  echo   [X] Could not fetch klines. Common causes:
  echo       - no internet connection
  echo       - Binance blocked in your region ^(try a VPN^)
  echo   The replay cannot run on real data without this step.
  goto end
)

echo.
echo   [2/2] Replaying and scoring against the benchmark...
echo.
node replay\replay.js BTCUSDT
if errorlevel 1 (
  echo.
  echo   [X] Replay failed. Tell Dimitry what the error said.
  goto end
)

echo.
echo   ================================================
echo    DONE
echo   ================================================
echo.
echo   Report written to:
echo     50_Training\Tools\replay-report.md    ^(read this^)
echo     50_Training\Tools\replay-report.json  ^(machine^)
echo.
echo   Now tell Dimitry "replay is done" and the results
echo   get read back to decide which watchers graduate.
echo.
:end
pause
