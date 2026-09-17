@echo off
REM ============================================================================
REM  세션 무인 갱신 (Windows 작업 스케줄러용)
REM
REM  브라우저가 되는 이 PC 에서 기기신뢰(_iat1, 2027까지 유효)로 OTP 없이 자동 로그인하고,
REM  그 세션을 DB 에 심는다. TAS 컨테이너 워커는 브라우저 없이 이 세션으로 수집한다.
REM  SSO 세션이 ~12h 라, 만료 전에 이 배치를 ~11h 마다 돌리면 수동 재시딩이 사라진다.
REM
REM  선행 조건:
REM   - .env 에 SR_USERNAME / SR_PASSWORD 설정
REM   - data/device.json (기기신뢰) 존재 — 최초 1회 'npm run login' 으로 OTP 통과해 생성
REM   - 헤드리스 실행용 브라우저: 없다고 나오면 한 번 'npx playwright install chromium'
REM
REM  결과 로그: data/refresh.log
REM ============================================================================
setlocal
cd /d "%~dp0.."
echo [%date% %time%] refresh 시작 >> "data\refresh.log"
call npm run refresh >> "data\refresh.log" 2>&1
echo [%date% %time%] refresh 종료 (exit %errorlevel%) >> "data\refresh.log"
endlocal
