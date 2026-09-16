#!/usr/bin/env bash
#
# TAS 수동 배포 — git pull(main) 후 cf push. VM 에서 실행한다.
# 전제: 이 레포가 VM 에 clone 되어 있고, cf CLI 로그인 가능, Node 24 설치.
#
# 사용:
#   export CF_API=https://api.<foundation>     # TAS API 엔드포인트 (필수)
#   export CF_USER=... CF_PASSWORD=...          # (필수)
#   # org/space 는 기본 PA. 다르면 export CF_ORG=... CF_SPACE=...
#   bash scripts/deploy.sh
#
# 무엇이 뜨는가:
#   web  (Next.js 뷰어·설정·API)  → cf push 로 뜬다
#   mcp  (챗봇 연결 서버)          → cf push 로 뜬다
#   worker(수집기)                → Scheduler 잡. 아래 6단계가 자동 등록 시도
#                                    (Scheduler for Tanzu 타일 + cf scheduler 플러그인 필요)
#
# ⚠ 런타임 미완 경고: 앱이 아직 SQLite/로컬 세션 파일에 의존한다. TAS 파일시스템은
#   재시작마다 초기화되므로 push 는 되어도 데이터·세션이 유지되지 않는다.
#   실제 운영은 Postgres 이전 + 세션 DB화 후. 지금은 스테이징/빌드 확인용.

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

echo "== 4) CF 로그인 (org=$CF_ORG space=$CF_SPACE) =="
: "${CF_API:?CF_API 를 설정하세요}"
: "${CF_USER:?CF_USER 를 설정하세요}"; : "${CF_PASSWORD:?CF_PASSWORD 를 설정하세요}"
cf api "$CF_API"
cf auth "$CF_USER" "$CF_PASSWORD"
cf target -o "$CF_ORG" -s "$CF_SPACE"

echo "== 5) cf push (web + mcp) =="
cf push -f manifest.yml

echo "== 6) worker 스케줄 잡 (없으면 생성) =="
ensure_worker_job() {
  # Scheduler for Tanzu 의 cf 플러그인이 없으면 cf jobs 가 실패한다 → 수동 안내로 넘어간다.
  if ! cf jobs >/tmp/_cfjobs 2>/dev/null; then
    echo "  Scheduler 플러그인/타일 없음 → 워커는 수동 설정 필요:"
    echo "    cf create-job broadcom-sr-web sr-collect \"node collector/collect.ts\""
    echo "    cf schedule-job sr-collect --cron \"*/15 8-20 * * *\""
    return 0
  fi
  if grep -q "sr-collect" /tmp/_cfjobs; then
    echo "  워커 잡(sr-collect) 이미 있음 — 스킵"
  else
    cf create-job broadcom-sr-web sr-collect "node collector/collect.ts"
    cf schedule-job sr-collect --cron "*/15 8-20 * * *"
    echo "  워커 잡 생성 + 15분 스케줄 등록"
  fi
}
ensure_worker_job || echo "  (워커 잡 설정 실패 — 위 명령으로 수동 등록)"

echo "== 완료. 'cf apps' 로 상태 확인 =="
