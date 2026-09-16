# Plan: Broadcom SR Hub — 수집 기반

**Source PRD**: `.claude/prds/broadcom-sr-hub.prd.md`
**Selected Milestone**: 1 — 수집 기반
**Complexity**: Medium

## Summary

케이스 목록과 답변 스레드를 주기적으로 수집해 팀 공용 SQLite에 적재하고, 무엇이 새로 들어왔는지 판정하는 계층을 만든다. 함께 수집 로그를 남겨 "마지막으로 언제 돌았고, 성공했는지, 세션이 살아있는지"를 웹에서 확인할 수 있게 한다. 이 마일스톤에서 사람이 보는 화면은 수집 로그 페이지 하나뿐이며, 케이스 열람 UI는 마일스톤 2로 미룬다.

## Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| Naming | 없음 — 그린필드 | 프로젝트에 TypeScript 코드가 없다. 전역 규칙(`~/.claude/rules/common/coding-style.md`)의 camelCase 함수·변수, PascalCase 타입, UPPER_SNAKE_CASE 상수를 따른다 |
| Errors | 없음 — 그린필드 | 전역 규칙의 "명시적 처리, 조용한 삼킴 금지"를 따른다. 본 마일스톤에서는 특히 세션 만료를 빈 결과로 흘리지 않는 것이 핵심 |
| Logging | 없음 — 그린필드 | `runs` 테이블에 구조화 기록. 콘솔은 사람이 읽는 요약만 |
| Data access | 없음 — 그린필드 | `node:sqlite`(Node 24 내장, 동작 검증 완료) 위에 얇은 래퍼. 네이티브 빌드 없음 |
| Tests | 없음 — 그린필드 | Node 내장 `node:test` + 캡처된 실제 응답 125건을 픽스처로 사용 |
| API 지식 | `captured/*.json`, `search_payload.json` | 실제 요청·응답 샘플이 있으므로 엔드포인트와 필드는 추측하지 않는다 |

> 코드 관례를 흉내낼 기존 구현이 없다. 위 항목은 전역 규칙과 실측 자산에서 가져온 것이며, 없는 패턴을 지어내지 않았다.

## Files to Change

| File | Action | Why |
|---|---|---|
| `package.json` | CREATE | 스크립트(`login`/`collect`/`dev`/`typecheck`/`test`) 및 의존성 |
| `tsconfig.json` | CREATE | strict 모드 |
| `.env.example` | CREATE | 포털 URL·수집 범위 등 설정 노출 |
| `collector/wolken/types.ts` | CREATE | 캡처된 응답에서 도출한 타입 |
| `collector/wolken/session.ts` | CREATE | 세션 복구·유효성 확인·만료 판정 |
| `collector/wolken/api.ts` | CREATE | **읽기 전용** 엔드포인트 래퍼 |
| `collector/lib/db.ts` | CREATE | `node:sqlite` 연결·스키마 적용 |
| `collector/lib/schema.sql` | CREATE | `cases` / `threads` / `runs` |
| `collector/lib/lock.ts` | CREATE | 단일 인스턴스 보장 |
| `collector/lib/diff.ts` | CREATE | 신규·변경 케이스, 신규 답변 판정 |
| `collector/login.ts` | CREATE | headed 수동 로그인(MFA) → 세션 저장 |
| `collector/collect.ts` | CREATE | 수집 파이프라인 진입점 |
| `app/layout.tsx` | CREATE | Next.js 최소 레이아웃 |
| `app/logs/page.tsx` | CREATE | 수집 로그 페이지 |
| `src/lib/db.ts` | CREATE | 뷰어 측 읽기 전용 DB 접근 |
| `test/*.test.ts` | CREATE | 캡처 픽스처 기반 파서·판정 테스트 |
| `.gitignore` | UPDATE | `data/`, `session.json`, `.next/`, `node_modules/` 추가 |
| `1_login_capture.py`, `2_probe_headers.py` | KEEP | 조사 자산. 포팅 후에도 참조용으로 남긴다 |

## Tasks

### Task 1: 스캐폴딩

- **Action**: `package.json`, `tsconfig.json`(strict), Next.js App Router 최소 구성, `.gitignore` 갱신. 의존성은 `next`, `react`, `playwright`, `typescript`, `tsx` 만. SQLite는 내장 모듈이라 추가하지 않는다
- **Mirror**: 전역 규칙 — 작은 파일 다수, 기능별 디렉터리
- **Validate**: `npm run typecheck` 통과, `npm run dev` 기동

### Task 2: DB 스키마

- **Action**: `schema.sql`에 세 테이블 정의
  - `cases(request_id PK, request_id_formatted, subject, status, priority, category, party_name, party_site_number, created_on, last_updated, first_seen_at, last_fetched_at, raw_json)`
  - `threads(thread_id PK, request_id, author_unit, author_unit_id, is_ours, res_date, res_date_val, body_html, body_text, fetched_at)`
  - `runs(run_id PK, started_at, finished_at, status, cases_seen, cases_changed, new_threads, session_state, error)`
  - `runs.status`는 `success | session_expired | failed` 세 값을 구분한다
- **Mirror**: 필드명은 `captured/065_v3.json`, `captured/094_get_unified_history.json`의 실제 응답에서 도출
- **Validate**: `node --test test/db.test.ts` — 스키마 적용 후 upsert·재실행 멱등성 확인

### Task 3: 세션 계층

- **Action**: `session.ts`에 세 가지 기능 — 저장된 세션으로 브라우저 컨텍스트 복구, `account_service/issessionvalid` 로 유효성 확인, 만료 시 `SessionExpiredError` 발생. 수집 성공 시 갱신된 세션을 다시 저장
- **Mirror**: 전역 규칙 — 오류를 삼키지 않고 명시적 타입으로 전파
- **Validate**: `node --test test/session.test.ts` — 만료 응답 픽스처에서 `SessionExpiredError`가 나오는지 확인

### Task 4: 읽기 전용 API 클라이언트

- **Action**: `api.ts`에 조회 함수만 구현 — 케이스 목록(페이지네이션), 케이스별 답변 스레드. 요청 페이로드는 `search_payload.json` 재사용. **생성·수정·삭제 함수를 정의하지 않는다**
- **Mirror**: `captured/065_v3.json`(목록 요청/응답), `captured/094_get_unified_history.json`(스레드)
- **Validate**: `node --test test/api.test.ts` — 캡처 응답을 파서에 넣어 타입과 필드 매핑 검증

### Task 5: 변경 감지

- **Action**: `diff.ts`에 판정 로직
  - 신규 케이스: `request_id`가 DB에 없음
  - 변경 케이스: `last_updated`가 저장값과 다름 → 스레드 재조회 대상
  - **새 답변**: `thread_id`가 DB에 없고 `is_ours === false`
  - `is_ours` 판정: `creatorFlag`와 `createdUserUnitName`(예: `"Broadcom Internal - Broadcom-ESD"`)을 함께 사용
- **Mirror**: `captured/094_get_unified_history.json`의 실제 스레드 2건이 픽스처
- **Validate**: `node --test test/diff.test.ts` — 최초 수집, 변경 없음, 우리 글만 추가, Broadcom 답변 추가 4개 시나리오

### Task 6: 단일 인스턴스 보장

- **Action**: `lock.ts` — 락 파일 기반. 이미 실행 중이면 즉시 종료하고 `runs`에 기록하지 않는다. 비정상 종료로 남은 락은 PID 확인 후 회수
- **Mirror**: 없음 — PRD 리스크 "수집기와 팀원 로그인이 세션을 밀어냄"의 직접 대응
- **Validate**: 두 프로세스 동시 실행 시 하나만 진행하는지 수동 확인

### Task 7: 수집 파이프라인

- **Action**: `collect.ts` — 락 획득 → 세션 복구·검증 → 목록 수집(페이지네이션) → 변경분만 스레드 수집 → DB 반영 → `runs` 기록 → 요약 출력. `--dry-run` 옵션은 DB에 쓰지 않는다. 요청 사이에 지연을 두어 접속 빈도를 낮게 유지
- **Mirror**: 전역 규칙 — 50줄 이하 함수로 분해
- **Validate**: `npm run collect -- --dry-run` 이 실제 케이스 건수를 출력

### Task 8: 로그인 스크립트

- **Action**: `login.ts` — headed 브라우저 기동, 사람이 MFA까지 완료, 창을 닫으면 세션 저장. 기존 `1_login_capture.py`의 검증된 흐름(브라우저 종료 감지, 실행 옵션 폴백)을 TypeScript로 포팅
- **Mirror**: `1_login_capture.py` — Windows에서 headed 실행이 간헐적으로 크래시하므로 옵션 폴백 체인을 유지
- **Validate**: 실행 후 세션 파일 생성, 이어서 `npm run collect -- --dry-run` 성공

### Task 9: 수집 로그 페이지

- **Action**: `app/logs/page.tsx` — 최근 실행 이력 표시(시각, 상태, 케이스 수, 신규 답변 수, 세션 상태, 오류). **`session_expired`를 "새 답변 0건"과 시각적으로 명확히 구분**한다. Server Component에서 DB 직접 조회, 캐싱 비활성화
- **Mirror**: 없음 — PRD 리스크 "세션 만료를 조용히 실패로 넘김"의 직접 대응
- **Validate**: `npm run dev` 후 `/logs` 에서 실행 이력이 보이는지 확인

## Validation

```bash
npm run typecheck          # TypeScript strict 통과
npm test                   # node:test — 캡처 픽스처 기반
npm run collect -- --dry-run   # DB 변경 없이 수집 경로 전체 확인
npm run dev                # /logs 페이지 확인
```

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| 수집 중 팀원이 포털에 로그인해 세션이 끊김 | High | `session_expired`로 명확히 기록하고 다음 주기 재시도. 실패를 "답변 없음"으로 표시하지 않는다 |
| 최초 수집 시 과거 케이스 전량 조회로 요청량이 튐 | Medium | 1차는 진행중 케이스만. 종료 케이스 백필은 별도 1회 작업으로 분리하고 지연을 넣는다 |
| `node:sqlite` API가 향후 변경 | Low | DB 접근을 `lib/db.ts` 한 곳에 격리해 교체 지점을 좁힌다 |
| Windows headed 실행 크래시 (조사 중 1회 발생) | Medium | 검증된 실행 옵션 폴백 체인을 포팅 |
| Next.js가 Server Component 결과를 캐싱해 최신 로그가 안 보임 | Medium | 해당 페이지 캐싱 비활성화 후 실제 확인 |
| 서버 부재로 스케줄 실행 주체가 없음 | High | 본 마일스톤은 수동 실행으로 완료 가능하도록 설계. 상시 가동 장비 확정 후 스케줄 등록 |

## Acceptance

- [x] Task 1–9 완료
- [x] `npm run typecheck` 오류 0 / `npm test` 22건 전부 통과
- [x] 세션이 없는 상태에서 실행하면 `session_expired`로 기록되고, 콘솔과 `/logs` 모두 "답변 없음"이 아님을 명시
- [x] `api.ts`에 생성·수정·삭제 함수가 존재하지 않음
- [x] 동시 실행 시 하나만 진행 (락 테스트 3건)
- [x] `/logs` 페이지가 실제 DB를 읽고, 만료 회차의 건수를 `0`이 아닌 `—`로 마스킹
- [x] 캡처 자산(`captured/094`, `captured/065`)을 픽스처로 재사용, 엔드포인트·필드 추측 없음
- [x] `npm run collect` 연속 3회 실행 — 1회차 8건/41답변 적재, 2·3회차 변경 0건·신규 0건 (멱등성 확인)
- [x] 3개월 백필 경계 동작 — 적재된 케이스 생성일 2026-08-26 ~ 09-01, 기준선(2026-06-02) 이후만 포함
- [x] `is_ours` 판정 정확 — Broadcom Internal 41건(is_ours=0) / KB Life Insurance 21건(is_ours=1)

## 구현 중 발견한 것

- Node 24가 `.ts`를 네이티브 실행하고 `node --test`도 지원해 **tsx 의존성을 제거**했다. `node:sqlite` 내장으로 better-sqlite3 네이티브 빌드도 불필요.
- **Next.js 번들 환경에서 `readFileSync(new URL(...))` 이 동작하지 않는다.** 서버 컴포넌트가 `schema.sql`을 읽지 못해 스키마를 문자열 상수(`lib/schema.ts`)로 인라인했다. `collector/api.ts`의 `payloads/search.json` 로딩은 Node 스크립트에서만 쓰이므로 영향 없다.
- `htmlToText`가 문단 구분을 잃는 버그를 테스트가 잡아냈다. 블록 요소의 여는 태그도 줄바꿈으로 처리하도록 수정.
- **API 서버가 `Origin` 헤더를 검증한다.** 세션이 유효해도 Origin 없이 호출하면 401이 돌아온다. 실측 비교: 헤더 없음 401 / Origin+Referer 200 / 페이지 내부 fetch 401. `lib/config.ts`의 `API_HEADERS`로 고정했다.
- **접속만 해도 세션 쿠키가 회전한다.** `--dry-run`에서 세션 저장을 건너뛰도록 만들었더니 dry-run이 자기 세션을 무효화시켰다. 세션 저장은 데이터 쓰기가 아니라 접속의 부수효과이므로 dry-run에서도 반드시 수행한다.
- **포털이 같은 답변을 내부/외부 뷰로 두 번 내려준다.** 실측: 같은 케이스·같은 작성자·동일 본문이 8초 간격, HTML 길이만 다름(1817 vs 1894). 62건 중 6그룹. DB에는 원본을 그대로 남기고 알림 판정에서만 합치도록 `dedupeReplies`를 두었다(41건 → 35건). 데이터 손실 없이 중복 알림만 제거.
- Windows headed 실행의 `Target crashed` 가 실제로 1회 재현됐다(`runs` 에 `failed` 로 기록됨). 폴백 체인이 있으나 완전히 사라지지는 않는다.
