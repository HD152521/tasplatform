#!/usr/bin/env bash
#
# TAS 수동 배포 — git pull(main) 후 cf push. VM 에서 실행한다.
# 전제:
#   - 이 레포가 VM 에 clone 돼 있고, Node 24 설치.
#   - cf 로그인이 이미 돼 있음 (cf login -a <API> 를 미리 해둔 상태).
#     org/space 는 기본 PA. 다르면 export CF_ORG=... CF_SPACE=...
#
# 사용:
#   bash scripts/deploy.sh
#
# 무엇이 뜨는가:
#   web  (Next.js 뷰어·설정·API)  → cf push 로 뜬다
#   mcp  (챗봇 연결 서버)          → cf push 로 뜬다
#   worker(수집기)                → 이 파운데이션엔 Scheduler 타일이 없다.
#                                    아래 6단계가 "수동 1회 실행" 명령을 안내한다
#                                    (cf run-task 는 CF 기본 기능이라 플러그인 불필요).
#
# ⚠ 런타임 미완 경고: 앱이 아직 SQLite/로컬 세션 파일에 의존한다. TAS 파일시스템은
#   재시작마다 초기화되므로 push 는 되어도 데이터·세션이 유지되지 않는다.
#   실제 운영은 Postgres 이전 + 세션 DB화 후. 지금은 스테이징/빌드 확인용.
#
# ⚠ 시크릿은 push 후 앱 환경변수로 넣어야 정상 작동:
#     cf set-env broadcom-sr-web SR_SECRET_KEY <키>
#     cf set-env broadcom-sr-web SR_USERNAME <계정>
#     cf set-env broadcom-sr-web SR_PASSWORD <비번>
#     cf restage broadcom-sr-web            # (mcp 앱에도 SR_SECRET_KEY 필요)

set -euo pipefail
cd "$(dirname "$0")/.."   # 레포 루트

BRANCH="${DEPLOY_BRANCH:-main}"
CF_ORG="${CF_ORG:-PA}"
CF_SPACE="${CF_SPACE:-PA}"

echo "== 1) 최신 코드 ($BRANCH) =="
git checkout "$BRANCH"
git pull --ff-only

echo "== 2) 의존성 · 프론트 빌드 =="
npm ci
npm run build            # Next.js(web). mcp/worker 는 빌드팩이 처리

echo "== 3) 검증(깨진 채 배포 방지) =="
npm run typecheck
npm test

echo "== 4) CF 타깃 확인 (이미 로그인돼 있어야 함) =="
if ! cf target >/dev/null 2>&1; then
  echo "  ✗ cf 로그인이 안 돼 있습니다. 먼저 실행하세요:"
  echo "      cf login -a <API-엔드포인트>"
  exit 1
fi
cf target -o "$CF_ORG" -s "$CF_SPACE"

echo "== 5) cf push (web + mcp) =="
cf push -f manifest.yml

echo "== 6) worker(수집기) 안내 =="
echo "  이 파운데이션엔 Scheduler 타일이 없어 자동 스케줄은 못 건다."
echo "  수집기를 지금 1회 수동 실행하려면 (플러그인 불필요, CF 기본 기능):"
echo "      cf run-task broadcom-sr-web --command \"node collector/collect.ts\" --name sr-collect"
echo "  (주기 실행은 Postgres 이전 후 별도 구성 예정 — 지금은 데이터가 ephemeral)"

echo "== 완료. 'cf apps' 로 상태 확인 =="
