@echo off
REM Entry point called by Task Scheduler.
REM Runs the collector from the project root and appends output to the log.
REM
REM Calls node directly instead of "npm run": measured, the npm wrapper alone
REM costs about 4.8s (npm spawns its own node, parses package.json, then
REM spawns node again). This job runs every 15 minutes, so that cost adds up.
REM ASCII only on purpose - cmd.exe reads this file in the system codepage.
cd /d "%~dp0.."
if not exist "data" mkdir "data"
echo. >> "data\collect.log"
echo ===== %DATE% %TIME% ===== >> "data\collect.log"
node collector/collect.ts >> "data\collect.log" 2>&1
exit /b %ERRORLEVEL%
