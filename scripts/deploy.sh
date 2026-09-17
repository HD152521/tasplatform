#!/usr/bin/env bash
#
# TAS 수동 배포 — git pull(main) 후 cf push. VM 에서 실행한다.
# 전제:
#   - 이 레포가 VM 에 clone 돼 있고, Node 24(또는 .ts 실행 가능한 최신 Node) 설치.
#   - cf 로그인이 이미 돼 있음 (cf login -a <API> 를 미리 해둔 상태).
#     org/space 는 기본 PA. 다르면 export CF_ORG=... CF_SPACE=...
#
# 사용:
#   # (A) 이미 만들어둔 Postgres 인스턴스를 바인딩 — 그 인스턴스 이름만 주면 된다:
#   export PG_SERVICE_INSTANCE=<cf services 에 보이는 인스턴스 이름>; bash scripts/deploy.sh
#   # (B) 인스턴스를 새로 만들어 바인딩 — offering·plan 을 주면 생성 후 바인딩:
#   export PG_SERVICE=<offering명> PG_PLAN=<플랜명>; bash scripts/deploy.sh
#   #     (이때 인스턴스 이름은 기본 sr-postgres, 바꾸려면 PG_SERVICE_INSTANCE 도)
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
#
# ⚠ DB 계정(공유 Postgres 대응): cf 바인딩은 앱마다 다른 롤을 발급해 web/mcp/worker 가
#   서로 만든 객체를 공유하지 못한다(Postgres 소유권). 그래서 고정 전용 계정 하나를 만들어
#   세 앱에 같은 접속 URL 로 넣는다. 예:
#     psql> CREATE ROLE paasops LOGIN PASSWORD '...';
#           GRANT CONNECT, CREATE ON DATABASE postgres TO paasops;
#           CREATE SCHEMA paasops AUTHORIZATION paasops;
#     cf set-env <app> SR_DATABASE_URL postgresql://paasops:...@<host>:5432/postgres
#     cf set-env <app> SR_PG_SCHEMA paasops
#   ★ 반드시 SR_DATABASE_URL 을 써라(DATABASE_URL 아님). TAS 의 Postgres 서비스 바인딩이
#     기동 직전 .profile.d 스크립트로 DATABASE_URL 을 "그 앱 전용 VCAP 롤" URL 로 덮어써서
#     cf set-env DATABASE_URL 은 무시된다. 코드는 SR_DATABASE_URL 을 최우선으로 본다.
#   set-env 값은 push/restage 에도 유지된다(여기 deploy.sh 에 넣지 않는다 — 시크릿).
#   manifest 의 서비스 바인딩은 네트워크 경로용으로 유지한다(자격은 SR_DATABASE_URL 이 이김).

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
  echo "  ✗ '$PG_SERVICE_INSTANCE' 라는 서비스 인스턴스가 없습니다. 둘 중 하나:"
  echo "    (A) 이미 만들어둔 인스턴스를 쓰려면 — cf services 에서 이름 확인 후:"
  echo "        export PG_SERVICE_INSTANCE=<그 인스턴스 이름>; bash scripts/deploy.sh"
  echo "    (B) 새로 만들려면 — cf marketplace 로 offering·plan 확인 후:"
  echo "        export PG_SERVICE=<offering> PG_PLAN=<플랜>; bash scripts/deploy.sh"
  exit 1
fi

echo "== 6) cf push (web + mcp, '$PG_SERVICE_INSTANCE' 바인딩) =="
cf push -f manifest.yml --var pg_instance="$PG_SERVICE_INSTANCE"

echo "== 7) worker(수집기) 안내 =="
echo "  아직 앱이 아니다(M2 에서 앱 내부 루프로 추가 예정). 지금 1회 수동 수집:"
echo "      cf run-task broadcom-sr-web --command \"node collector/collect.ts\" --name sr-collect"

echo "== 완료. 'cf apps' / 'cf services' 로 상태 확인 =="
