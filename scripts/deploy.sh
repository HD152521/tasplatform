#!/usr/bin/env bash
#
# TAS 수동 배포 — git pull(main) 후 cf push. VM 에서 실행한다.
# 전제:
#   - 이 레포가 VM 에 clone 돼 있고, Node 24(또는 .ts 실행 가능한 최신 Node) 설치.
#   - cf 로그인이 이미 돼 있음 (cf login -a <API> 를 미리 해둔 상태).
#     org/space 는 기본 PA. 다르면 export CF_ORG=... CF_SPACE=...
#
# 사용:
#   bash scripts/deploy.sh
#   # Postgres 서비스가 아직 없으면 서비스명·플랜을 넘겨 자동 생성:
#   export PG_SERVICE=<마켓플레이스 서비스명> PG_PLAN=<플랜명>; bash scripts/deploy.sh
#
# 무엇이 뜨는가:
#   web  (Next.js 뷰어·설정·API)  → cf push
#   mcp  (챗봇 연결 서버)          → cf push
#   worker(수집기)                → 아직 앱 아님. 필요 시 cf run-task 로 1회 실행(아래 7단계).
#
# 데이터: web·mcp 가 sr-postgres 를 바인딩한다. 앱이 VCAP_SERVICES 로 붙어 첫 起動에
#   스키마를 자동 생성한다. 재시작에도 데이터가 유지된다.
#
# ⚠ 세션/기기신뢰는 아직 로컬 파일이라 재시작 시 로그인 세션은 유지되지 않는다(수집기
#   재로그인 필요). 세션 DB화는 다음 단계 작업.
#
# ⚠ 시크릿: 레포 루트에 .env 를 두면 push 때 함께 올라가 loadEnv() 가 읽는다
#   (.cfignore 가 .env 포함을 보장). web·mcp 가 같은 .env 하나를 본다.
#     SR_SECRET_KEY=<32바이트키>
#     SR_USERNAME=<브로드컴계정>
#     SR_PASSWORD=<비번>
#   .env 는 절대 커밋하지 않는다(.gitignore 유지). 대안: cf set-env + cf restage.

set -euo pipefail
cd "$(dirname "$0")/.."   # 레포 루트

BRANCH="${DEPLOY_BRANCH:-main}"
CF_ORG="${CF_ORG:-PA}"
CF_SPACE="${CF_SPACE:-PA}"
PG_SERVICE_INSTANCE="${PG_SERVICE_INSTANCE:-sr-postgres}"

echo "== 1) 최신 코드 ($BRANCH) =="
git checkout "$BRANCH"
git pull --ff-only

echo "== 2) 의존성 · 프론트 빌드 =="
npm ci
npm run build            # Next.js(web). mcp 는 빌드팩이 처리

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

echo "== 5) Postgres 서비스 확인 ($PG_SERVICE_INSTANCE) =="
if cf service "$PG_SERVICE_INSTANCE" >/dev/null 2>&1; then
  echo "  서비스 인스턴스 '$PG_SERVICE_INSTANCE' 이미 있음 — 스킵"
elif [ -n "${PG_SERVICE:-}" ] && [ -n "${PG_PLAN:-}" ]; then
  echo "  생성: cf create-service $PG_SERVICE $PG_PLAN $PG_SERVICE_INSTANCE"
  cf create-service "$PG_SERVICE" "$PG_PLAN" "$PG_SERVICE_INSTANCE"
  echo "  프로비저닝 대기(최대 ~5분)..."
  for _ in $(seq 1 30); do
    line="$(cf service "$PG_SERVICE_INSTANCE" 2>/dev/null | grep -iE 'status:' | head -1 || true)"
    echo "    ${line:-(상태 조회 중)}"
    echo "$line" | grep -qi "create succeeded" && { echo "  준비 완료"; break; }
    echo "$line" | grep -qi "failed" && { echo "  ✗ 프로비저닝 실패"; exit 1; }
    sleep 10
  done
else
  echo "  ✗ '$PG_SERVICE_INSTANCE' 서비스가 없습니다. Postgres 서비스/플랜을 정해 만들어야 합니다:"
  echo "      cf marketplace                              # postgres 서비스명·플랜 확인"
  echo "      cf create-service <서비스> <플랜> $PG_SERVICE_INSTANCE"
  echo "    또는 이 스크립트가 자동 생성하도록:"
  echo "      export PG_SERVICE=<서비스> PG_PLAN=<플랜>; bash scripts/deploy.sh"
  exit 1
fi

echo "== 6) cf push (web + mcp, sr-postgres 바인딩) =="
cf push -f manifest.yml

echo "== 7) worker(수집기) 안내 =="
echo "  아직 앱이 아니다(M2 에서 앱 내부 루프로 추가 예정). 지금 1회 수동 수집:"
echo "      cf run-task broadcom-sr-web --command \"node collector/collect.ts\" --name sr-collect"

echo "== 완료. 'cf apps' / 'cf services' 로 상태 확인 =="
