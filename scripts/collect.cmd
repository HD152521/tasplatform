@echo off
REM 작업 스케줄러가 호출하는 진입점.
REM 프로젝트 폴더로 이동한 뒤 수집기를 돌리고, 출력을 로그로 남긴다.
cd /d "%~dp0.."
if not exist "data" mkdir "data"
echo. >> "data\collect.log"
echo ===== %DATE% %TIME% ===== >> "data\collect.log"
call npm run collect >> "data\collect.log" 2>&1
exit /b %ERRORLEVEL%
