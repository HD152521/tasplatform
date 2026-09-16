#!/usr/bin/env bash
#
# TAS 수동 배포 — git pull 후 cf push.
# 배포 머신에서 실행한다(cf CLI 로그인 가능 + Node 24 + 이 레포 clone 되어 있어야 함).
#
# 사용:
#   export CF_API=https://api.<foundation>      # TAS API 엔드포인트
#   export CF_USER=... CF_PASSWORD=...
#   export CF_ORG=... CF_SPACE=...
#   bash scripts/deploy.sh
#
# ⚠ 현재 상태 경고:
#   앱이 아직 SQLite/로컬 세션 파일에 의존한다. TAS 파일시스템은 재시작마다 초기화되므로
#   cf push 는 되어도 런타임은 완전히 동작하지 않는다(세션 소실, DB 초기화).
#   이 스크립트는 "배포 기계장치"를 굴려보기 위한 것이고, 실제 운영은
#   Postgres 이전 + 세션 DB화가 끝난 뒤라야 한다. 그 전까지는 스테이징/빌드 확인용.

set -euo pipefail
cd "$(dirname "$0")/.."   # 레포 루트

echo "== 1) 최신 코드 =="
git pull --ff-only

echo "== 2) 의존성 · 프론트 빌드 =="
npm ci
npm run build            # Next.js(web). mcp/worker 는 빌드팩이 처리

echo "== 3) 검증(깨진 채 배포 방지) =="
npm run typecheck
npm test

echo "== 4) CF 로그인 =="
: "${CF_API:?CF_API 를 설정하세요}"
: "${CF_USER:?}"; : "${CF_PASSWORD:?}"; : "${CF_ORG:?}"; : "${CF_SPACE:?}"
cf api "$CF_API"
cf auth "$CF_USER" "$CF_PASSWORD"
cf target -o "$CF_ORG" -s "$CF_SPACE"

echo "== 5) cf push (web + mcp) =="
cf push -f manifest.yml

# == 6) worker(수집기)는 Scheduler 잡으로 (최초 1회만 create, 이후는 스킵) ==
#   Scheduler for Tanzu 타일이 있어야 한다.
#   cf create-job broadcom-sr-web sr-collect "node collector/collect.ts"
#   cf schedule-job sr-collect --cron "*/15 8-20 * * *"

echo "== 완료. 'cf apps' 로 상태 확인 =="
