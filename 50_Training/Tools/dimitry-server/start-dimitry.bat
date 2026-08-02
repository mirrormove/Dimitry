@echo off
REM ==========================================================
REM  Dimitry server launcher.
REM  Starts the local server with the security token set.
REM  Double-click to run manually, or let auto-start run it.
REM ==========================================================
cd /d "%~dp0"
set DIMITRY_TOKEN=35936c07f38c5d3b4972ecd9e5e2dc3492f2a32c7cb2c901
node server.js
