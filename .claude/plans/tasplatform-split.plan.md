# Plan: TAS Platform 3계층 전환 + 챗봇

**대상**: `projects/broadcom-sr` (Next.js, 유지) 옆에 `projects/tasPlatform_front` (React) · `projects/tasPlatform_back` (Spring Boot) 신규
**복잡도**: Large
**언어**: Java (백엔드·Agent) + TypeScript (프론트) — 폴리글랏

## 요약

지금 동작 중인 Next.js 단일 앱을 그대로 둔 채, 옆에 React 프론트와 Spring Boot 백엔드를 세워 기능을 옮긴다.
이어서 지정 소스만 근거로 답하는 챗봇을 만들고, 그 대화를 Jira 티켓 · Confluence 문서 · Broadcom SR 로 이어지게 한다.

## 확정 사항

- 백엔드 언어는 **Java (Spring Boot)**. 사용자가 직접 유지보수한다.
- 챗봇은 **지정 소스에 근거가 없으면 "모른다"** 고 답한다. 모델 자체 지식으로 메우지 않는다.
- 허용 소스: 사내 Jira · Confluence · S3 · Broadcom 공식 KB. 추가 기술 문서 사이트는 별도 지정 예정.
- 폐쇄망은 이 플랫폼과 무관하다.

## 이관 대상 실측

| 구분 | 규모 |
|---|---|
| `lib/` | 4,229행 / 28개 |
| `collector/` | 1,281행 / 9개 |
| `app/` | 4,385행 / 38개 (화면 21 + API 라우트) |
| `test/` | 842행 / 85건 통과 |
| `scripts/build_report.py` | 353행 (PPT 생성) |
| DB | 9테이블 / 약 4,300행 (cases 300 · threads 3,431 · attachments 450 · cves 52) |

## 반드시 지켜야 할 제약 (실측으로 얻은 것)

1. **브로드컴 세션 쿠키는 요청마다 회전한다.** 두 프로세스가 동시에 만지면 세션이 죽는다.
   → 세션을 만지는 코드는 **단일 프로세스·단일 인스턴스(Agent)** 로 몰고, API 는 Agent 를 호출한다.
2. **Origin 헤더가 없으면 401.** 쿠키만으로는 안 된다.
3. **"수집 실패" 와 "새 답변 0건" 을 절대 같게 표시하지 않는다.**
4. 브로드컴 쓰기(답변·SR)는 **사람이 화면에서 확인한 뒤에만** 나간다.
5. 케이스 본문은 OpenAI 로만 보낸다. 무료 티어(Gemini·Groq)는 CVE 번역 전용.

## 아키텍처

```
tasPlatform_front (React)      화면
tasPlatform_back  (Spring)     DB · Jira · Confluence · OpenAI · Slack · RAG   (여러 대 가능)
  └ broadcom-agent (Spring)    Playwright · 세션 소유 · 수집 · 브로드컴 쓰기   (반드시 1대)
```

## 이번 범위 밖 (Out of scope)

- 정기점검 PPT 생성 · Confluence 문서 생성은 **기존 Next 앱이 계속 담당**한다. 이번에 옮기지 않는다.
- 첨부 업로드(supportftp)는 다루지 않는다.
- 회의록·경비·Script 검증 등 나머지 로드맵 기능은 이번 범위가 아니다.

---

## Step 1 — playwright-java 실현 가능성 검증

Spring Boot 에서 `playwright-java` 로 브로드컴에 실제로 붙는지 확인한다.
`browserContext.request()` 가 브라우저 쿠키 항아리를 공유하는지, `storageState` 저장·복원이 되는지, Origin 헤더 주입이 되는지 세 가지를 본다.
**이것이 안 되면 Agent 설계 전체가 바뀐다.** 다른 단계보다 먼저 한다.

Out of scope: 수집 로직 전체 이식. 로그인 1회 + 케이스 목록 1건 조회만 확인한다.

## Step 2 — Spring Boot 뼈대와 DB 이관

`tasPlatform_back` 프로젝트를 만들고 Postgres 스키마 9테이블을 세운다.
기존 SQLite(`data/sr.db`, 4,300행)를 Postgres 로 옮기는 일회성 이관을 만든다.
`lib/schema.ts` 의 제약(runs.status 3값, case_summaries 복합 PK, cves 복합 PK)을 그대로 옮긴다.

Out of scope: 애플리케이션 로직. 스키마와 이관만 한다.

## Step 3 — 수집기를 Agent 로 이관

`collector/` 1,281행을 Spring Boot Agent 로 옮긴다. 세션 관리 · 15분 주기 수집 · 동시 실행 방지 락 · Slack 알림.
기존 Next 수집기와 **같은 기간을 수집해 결과를 대조**한다. 병행 기간에는 한쪽만 실제 수집하고 다른 쪽은 읽기만 한다.

Out of scope: 브로드컴 쓰기(답변·SR 등록). Step 6 에서 다룬다.

## Step 4 — 읽기 API

케이스 목록·상세·스레드·첨부·CVE·수집 로그 조회 REST 엔드포인트를 만든다.
`lib/queries.ts` 368행의 쿼리 의미를 그대로 옮긴다. 특히 안읽음 판정(`unread_replies`)과 중복 답변 처리를 유지한다.

Out of scope: 쓰기 엔드포인트.

## Step 5 — React 프론트 뼈대와 읽기 화면 이관

`tasPlatform_front` 를 만들고 케이스 목록·상세·CVE·수집 로그 화면을 옮긴다.
기존 `app/ui.tsx` 의 색·간격 규칙과 `formatStamp` 의 로케일 비의존 날짜 표기를 유지한다.

Out of scope: 챗봇 화면. Step 9 에서 만든다.

## Step 6 — 브로드컴 쓰기 경로

답변 전송과 SR 등록을 API → Agent 내부 호출 구조로 만든다.
전송 직전에 실제로 나갈 내용을 화면에 그대로 보여주는 확인 단계를 유지한다.
낙관적 잠금(`requestMasterVO.version`)을 매번 새로 읽는 동작을 그대로 옮긴다.

Out of scope: 첨부 업로드.

## Step 7 — 지식 베이스 색인

Jira · Confluence · 수집된 SR · 지정 문서 소스를 읽어 청크로 나누고 임베딩해 pgvector 에 넣는다.
출처(문서 종류 · 원본 URL · 갱신 시각)를 청크마다 저장한다. 나중에 답변에서 근거를 보여줘야 한다.
증분 갱신을 지원한다 — 전체 재색인은 비용이 크다.

Out of scope: 챗봇 응답 생성. Step 8 에서 다룬다.

## Step 8 — 챗봇 응답 (엄격한 출처 제한)

질문을 받아 지식 베이스를 검색하고, **검색 결과에 근거가 없으면 "모른다" 고 답한다.**
모델 자체 지식으로 메우지 않는다. 답변에는 근거 문서와 링크를 반드시 붙인다.
검색은 됐지만 관련성이 낮은 경우도 "모른다" 로 처리한다.

Out of scope: 채팅 화면. Step 9 에서 만든다.

## Step 9 — 채팅 화면

React 채팅 화면. 스트리밍 응답, 근거 문서 표시, 대화 이력 보관.

Out of scope: 대화에서 문서·티켓을 만드는 기능. Step 10 에서 다룬다.

## Step 10 — 대화에서 Jira · Confluence · SR 만들기

대화 내역을 골라 Jira 티켓 · Confluence 문서 · Broadcom SR 초안으로 바꾼다.
Confluence 는 팀의 SR 현행화 양식(제목 → 환경 표 → 네 섹션)을 따른다.
셋 다 **사람이 확인한 뒤에만** 실제로 등록된다.

Out of scope: 일정·팀 업무 등록. 다음 계획에서 다룬다.

---

## 위험

| 위험 | 정도 | 대응 |
|---|---|---|
| `playwright-java` 가 `context.request()` 를 다르게 다룸 | 높음 | Step 1 에서 먼저 확인 |
| 두 시스템이 같은 세션 파일을 만져 서로 죽임 | 높음 | 병행 기간에 수집은 한쪽만 |
| 85건 테스트 자산 소실 | 중간 | 순수 함수부터 JUnit 으로 이식 |
| 챗봇이 근거 없이 답함 | 중간 | 근거 없음 케이스를 테스트로 고정 |
| 전환 중 업무 중단 | 중간 | 기존 Next 앱을 끝까지 유지 |

## 검증

```bash
# 백엔드
cd tasPlatform_back && ./gradlew test
# 프론트
cd tasPlatform_front && npm test && npx tsc --noEmit
# 기존 앱 (계속 통과해야 함)
cd broadcom-sr && npm test && npx tsc --noEmit
```

## 완료 기준

- [ ] Step 1 검증 결과가 문서로 남았다
- [ ] 기존 Next 앱이 계속 동작한다
- [ ] 수집 결과가 양쪽에서 일치한다
- [ ] 챗봇이 근거 없는 질문에 "모른다" 고 답한다
