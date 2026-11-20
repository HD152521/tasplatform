# Plan: TAS Platform — Python 단일 백엔드 + React

**대상**: `projects/tasPlatform_back` (Python/FastAPI, Spring 폐기 후 재작성) · `projects/tasPlatform_front` (React)
**기존 앱**: `projects/broadcom-sr` (Next.js) — 전환이 끝날 때까지 계속 운영한다
**설계 근거**: `C:\Users\안용식\rag-chatbot-design.md` (RAG 설계 문서. D1~D18 결정은 전제로 사용)
**복잡도**: Large

## 요약

지금 동작 중인 Next.js 앱을 그대로 둔 채, Python 백엔드와 React 프론트를 새로 만든다.
**챗봇을 먼저 만들고 기존 기능 이관은 뒤로 미룬다** — 기존 앱이 그 일을 계속 하고 있으므로,
지금 없는 기능(챗봇)을 먼저 내놓는 쪽이 값어치가 빨리 나온다.

## 확정 사항 (재논의하지 않는다)

| # | 결정 | 근거 |
|---|---|---|
| C1 | **백엔드는 Python 하나**. Java/Spring 폐기 | 무거운 작업(임베딩·리랭커·문서파싱·PPT·LLM)이 전부 Python 쪽. Spring 강점(동시성·트랜잭션·Security)이 쓰일 자리가 없음. 15명·150질의/일 규모에서 서비스를 쪼개면 없던 실패 유형만 생김 |
| C2 | **런타임 하나, 프로세스 둘** (`web` / `worker`) | 임베딩은 CPU 바운드라 API 프로세스에서 돌리면 GIL 로 응답이 막힘. 언어를 나누는 게 아니라 작업 성격으로 프로세스만 나눔 |
| C3 | **생성 LLM 은 OpenAI** (설계문서 D2 를 Claude → OpenAI 로 변경) | 이미 키·모델(gpt-4.1)이 검증되어 운영 중 |
| C4 | **임베딩·리랭커는 로컬** (설계문서 D3 유지) | 한국어 검색에서 BGE-M3 가 OpenAI 임베딩보다 낫다. 비용 때문이 아니라 품질 때문 |
| C5 | **mypy --strict 를 처음부터 켠다** | 정적 타입을 포기한 대가를 상쇄. 기존 앱이 `tsc --noEmit` 를 계속 돌리는 것과 같은 방식 |
| C6 | 설계문서 **D1·D4~D18 은 그대로 전제** | 이미 근거를 검토해 확정된 것 |

## 폐기하는 것

- `tasPlatform_back` 의 Spring Boot 구현 — Step 1(playwright-java 검증) 산출물 중 **검증 문서만 남기고** 코드는 버린다.
  검증으로 알아낸 사실(storageState 동작, 쿠키 항아리 공유 필요, Origin 필수)은 Python 에 그대로 적용된다.

## 아키텍처

```
tasPlatform_front (React)        화면 (케이스 열람 · 채팅)
        │
tasPlatform_back (Python)        Postgres 하나 · 스키마 분리 (rag.* / sr.*)
  ├─ web    FastAPI              질의응답 · 업무 API · 스트리밍
  └─ worker 같은 코드            수집(15분) · 색인 · 보고서 생성
```

## 이번 계획의 범위 밖

- 정기점검 PPT 생성 · Confluence 문서 생성은 **기존 Next 앱이 계속 담당**한다 (Step 11 까지)
- 첨부 업로드 (파일 서버 인증이 별개이고 실체가 내부 이관됨)
- 회의록·경비·Script 검증 등 로드맵 나머지
- 폐쇄망 대응

---

## Step 1 — 프로젝트 뼈대와 스키마

`tasPlatform_back` 의 Spring 구현을 걷어내고 Python/FastAPI 로 다시 세운다.
Postgres 에 `pgvector` 확장을 넣고 RAG 스키마 5테이블(`chunks`, `env_history`, `threads`, `feedback`, `unanswered`)을 만든다.
설계 문서 5장의 DDL 을 그대로 쓴다. `mypy --strict` 와 pytest 를 처음부터 건다.
`broadcom-sr/.env` 를 그대로 복사해 쓴다.

Out of scope: 수집·색인·검색 로직. 뼈대와 스키마만.

## Step 2 — env_history 채우기

관리 대상 제품과 버전 이력을 `env_history` 에 넣는다. 사용자가 제공한 목록만 쓰고 추측하지 않는다.
설계 문서 15장이 0단계로 못박은 항목이다 — 이것이 없으면 버전 미상 문서를 처리할 방법이 없어 검색 단계에서 막힌다.

Out of scope: 버전 자동 추론. 그건 Step 4 에서 다룬다.

## Step 3 — 로컬 임베딩·리랭커 검증

BGE-M3 급 임베딩 모델과 리랭커를 실제로 돌려 속도·메모리를 측정한다.
한국어 + 영문 기술용어가 섞인 실제 문장으로 확인한다.
**이 결과에 따라 색인 배치 크기와 워커 구성이 정해진다.**

Out of scope: 색인 파이프라인 전체. 모델이 이 PC 에서 실용적인 속도로 도는지만 본다.

## Step 4 — Confluence 수집·청킹·색인

Confluence 를 읽어 파싱·청킹하고 문맥 헤더를 붙여 임베딩해 `chunks` 에 넣는다.
설계 문서 4장(청킹)과 6장(버전 추출)을 따른다. 표·코드 블록을 청킹으로 쪼개지 않는다.
청크마다 출처(문서 종류·원본 URL·갱신 시각)를 저장한다. 증분 갱신과 삭제 tombstone 을 포함한다.

Out of scope: S3·Jira 수집. 검색 로직.

## Step 5 — 하이브리드 검색과 환경 재정렬

BM25(Postgres FTS) + 벡터 검색을 RRF 로 합치고, 사용자 환경(제품·버전) 일치도로 재정렬한다.
설계 문서 6장의 `env_score` 계산을 그대로 쓴다 — 메이저 불일치 0.15 같은 값은 근거가 문서에 있으므로 임의로 바꾸지 않는다.
**환경 조건을 하드 필터로 걸지 않는다** (D14). 평가셋 30문항을 만들어 리콜@8 과 버전 정확도를 측정한다.

Out of scope: LLM 생성. 검색까지만.

## Step 6 — 생성과 엄격성 강제

검색 결과로 답을 만든다. **근거가 없으면 "모른다"고 답하고 LLM 을 아예 호출하지 않는다.**
설계 문서 8장의 임계값 차단·인용 검증 후처리를 구현한다. 답변에는 근거 문서와 링크를 붙인다.
검색은 됐으나 관련성이 낮은 경우도 "모른다"로 처리한다.

Out of scope: 다중 턴 대화. 단일 질문 응답까지만.

## Step 7 — Jira 수집과 라우팅

Jira 이슈를 수집해 `doc_type='task'` 로 색인한다. **절차 근거로 인용되지 않게 막는다** (D12).
질문 성격에 따라 검색 대상을 고르는 라우팅을 넣는다. fixVersion 으로 버전을 역추론해 커버리지를 재측정한다.

Out of scope: S3 수집 (Q1 답이 나온 뒤 별도 단계).

## Step 8 — 대화

쿼리 재작성, 스레드 단위 격리, 환경 오버라이드를 넣는다.
**검색 청크를 대화 히스토리에 누적하지 않는다** (D18) — 인용 ID 만 남긴다.

Out of scope: 화면.

## Step 9 — React 채팅 화면

`tasPlatform_front` 를 만들고 채팅 화면을 붙인다. 스트리밍 응답, 근거 문서 표시, 대화 이력.
색·간격은 `broadcom-sr/app/ui.tsx` 를 따르되 꾸미지 않는다. 디자인은 나중에 손본다.

Out of scope: 케이스 열람 화면. Step 11 에서 만든다.

## Step 10 — 대화에서 Jira · Confluence · SR 만들기

대화 내역을 골라 Jira 티켓 · Confluence 문서 · Broadcom SR 초안으로 바꾼다.
Confluence 는 팀의 SR 현행화 양식(제목 → 환경 표 → 네 섹션)을 따르고 storage format 으로 보낸다.
셋 다 사람이 확인한 뒤에만 등록된다. 봇 생성물은 `reviewed=FALSE` 로 저장해 색인에서 제외한다 (설계문서 8장 ⑦).

Out of scope: 일정·팀 업무 등록.

## Step 11 — 기존 SR 기능 이관

`broadcom-sr` 의 SQLite 데이터(케이스 300 · 스레드 3,431 · 첨부 450 · CVE 52)를 `sr.*` 스키마로 옮기고,
Playwright 수집기를 Python 으로 이관한다. 케이스 열람 화면을 React 로 옮긴다.
**수집은 반드시 단일 워커에서만 돈다.** 병행 기간에는 한쪽만 실제 수집하고 다른 쪽은 읽기만 한다.

Out of scope: 보고서 생성. Step 12.

## Step 12 — 보고서·문서 생성 이관

정기점검 PPT 생성(`scripts/build_report.py` 353행)과 Confluence 문서 생성을 Python 백엔드로 흡수한다.
**PPT 코드는 이미 Python 이므로 그대로 가져다 쓴다.** 기존 Next 앱을 중단한다.

Out of scope: 없음. 이 단계로 전환이 끝난다.

---

## 반드시 지켜야 할 것 (실측으로 얻은 것)

1. **브로드컴 세션을 만지는 곳은 단일 프로세스여야 한다.** 쿠키 항아리 공유 요청이 필요하고(대조군 401로 증명), SSO 갱신 시 경합이 난다.
2. **Origin 헤더가 없으면 401.** 쿠키만으로는 안 된다.
3. **"수집 실패"와 "새 답변 0건"을 절대 같게 표시하지 않는다.**
4. 브로드컴·Jira·Confluence 쓰기는 **사람이 화면에서 확인한 뒤에만** 나간다.
5. 케이스 본문·사내 문서는 학습에 쓰지 않는 유료 API 로만 보낸다.

## 위험

| 위험 | 정도 | 대응 |
|---|---|---|
| 로컬 임베딩이 이 PC 에서 너무 느림 | 높음 | Step 3 에서 먼저 측정. 느리면 배치·워커 구성을 조정하거나 API 로 후퇴 |
| `env_history` 가 비어 검색이 흔들림 | 높음 | Step 2 를 Step 4 앞에 둠. 사용자 확인 없이 추측하지 않음 |
| 챗봇이 근거 없이 답함 | 중간 | 근거 없음 케이스를 테스트로 고정 (Step 6) |
| 두 시스템이 같은 세션을 만져 로그인이 끊김 | 중간 | Step 11 병행 기간에 수집은 한쪽만 |
| 전환 중 업무 중단 | 중간 | 기존 Next 앱을 Step 12 까지 유지 |
| Python 동적 타입으로 런타임 오류 | 중간 | `mypy --strict` + pytest. 기존 테스트 85건을 이식 |

## 검증

```bash
cd tasPlatform_back && mypy --strict . && pytest
cd tasPlatform_front && npm test && npx tsc --noEmit
cd broadcom-sr && npm test && npx tsc --noEmit   # 계속 통과해야 함
```

## 사람 확인이 필요한 것

- [ ] **Q5 — 관리 대상 제품 목록과 버전 이력** (Step 2 재료. 없으면 진행 불가)
- [ ] Q1 — S3 가 Confluence 백업인가 독립 관리인가 (S3 수집 여부가 갈림)
- [ ] Q2 — S3 키 경로 규칙이 일관적인가
- [ ] Q3 — Confluence 에 제품/버전 라벨 체계가 있는가
- [ ] Q4 — Confluence ↔ Jira 링크가 실제로 걸려 있는가
- [ ] 배포 위치
