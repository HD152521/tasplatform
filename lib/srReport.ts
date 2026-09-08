/**
 * SR 상세 슬라이드용 보고서 생성.
 *
 * ⚠ 케이스 본문이 외부로 나가는 유일한 경로다.
 *   고객사(금융권) 인프라 정보가 들어 있으므로 무료 티어에 보내면 안 된다.
 *   그래서 CVE 번역이 쓰는 lib/translate.ts (Gemini·Groq) 와 분리해 두고,
 *   여기서는 OPENAI_API_KEY 만 쓴다. 이 키를 다른 용도로 돌려쓰지 말 것.
 *
 * 프롬프트는 팀에서 쓰던 것을 그대로 옮겼다. 형식이 곧 슬라이드 칸이라
 * 라벨 문구를 바꾸면 파싱이 깨진다.
 */
import "server-only";
import { openDb } from "./db.ts";
import { chat } from "./openai.ts";
import { isoNow } from "./dates.ts";
import { getCase, listThreads } from "./queries.ts";
import { buildSourceText, parseSrReport, type SrReport } from "./srReportFormat.ts";

export class SrReportError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`SR 보고서 생성 실패 (HTTP ${status}): ${detail}`.trim());
    this.name = "SrReportError";
    this.status = status;
  }
}

const SYSTEM_PROMPT = `너는 Broadcom TAC SR(Service Request) 문서를 표준화된 한국어 보고서로 정리하는 전문가다.
입력으로 SR 내역이 주어지면, 아래 규칙에 따라 정확히 3개 항목의 보고서만 출력한다.

# 절대 원칙
- 원본 자료에 없는 단어, 사실, 수치를 추가하지 않는다.
- 보고서 외의 설명, 인사말, 서론, 규칙 언급, 마크다운 코드펜스를 출력하지 않는다.
- 원문이 영문이어도 출력은 전부 한국어로 작성한다. (제품명·컴포넌트명 등 고유명사는 영문 유지)

# 출력 형식 (이 형식 그대로, 라벨 텍스트 변경 금지)
SR 제목
- • {제목}

분석 및 진행상황

- 질의 내용
{항목}

{항목}

- 진행 상황
{라벨}: {내용}

{라벨}: {내용}

최종 결과
- • {한 문장 요약}

# 1. SR 제목
- Subject 필드 기반, 한국어로 간결하게.
- 현상 또는 요청 목적이 드러나도록 명사형 종결.

# 2. 질의 내용
- 고객이 무엇을 궁금해하고 요청했는지만 다룬다.
- 첫 항목은 배경·상황 중심, 이후 항목은 구체적 요청·질문 중심. 단, 상황과 요청이 한 맥락이면 한 항목에 함께 담는다.
- 항목 수는 최소 1개, 통상 2~4개. 분량을 채우기 위한 억지 분리 금지.
- 버전·환경·컴포넌트 등 기술 범위는 독립 항목으로 나열하지 않고 관련 항목 안에 녹인다. 단, 수치나 대상 범위는 생략하지 않는다.
- "TAC", "TAC 검토 요청", "TAC 확인 요청" 등 응대 주체를 지칭하는 표현 사용 금지. 검토·확인의 대상과 목적만 쓴다.
- 첨부 파일명, 로그 파일, 명령어 등 절차적 내용 제외.
- 글머리 기호 사용 금지. 항목 구분은 빈 줄만 사용.

## 종결 형식 (서술형 어미 금지, 명사형 단독 종결)
금지: ~요청함 / ~확인함 / ~필요함 / ~한 상태 / ~인 상황 / ~이어서 / ~하였으며
허용: ~발생 / ~확인 / ~점검 / ~수립 가이드 요청 / ~지원 요청

| 금지 | 허용 |
|---|---|
| UAA 정의 문서를 작성한 상태 | UAA 정의 문서 작성 완료 |
| 수동 재기동하여 임시 복구한 상태 | 수동 재기동으로 임시 복구 |
| 설정 항목을 찾을 수 없는 상황 | Ops Manager 타일 설정 화면에서 관련 항목 미확인 |
| 변경이 필요한 상태 | 변경 필요 |

# 3. 진행 상황
반드시 아래 흐름을 지킨다.
① 원인 분석 — 현상이 왜 발생했는지 근거와 배경 중심. 조치 방향만 쓰지 말고 어떤 분석으로 그 결론에 이르렀는지 인과 흐름을 유지한다.
② 진행 경과 — TAC과 고객사가 각각 무엇을 했는지 주체를 구분한다. TAC 안내는 "~안내받음/~파악됨/~확인됨", 고객 수행은 "~확인/~제출/~조치".
③ 향후 조치 방향 — 마지막 항목에 반드시 포함한다.

- "[라벨]: 내용" 형식. 4~6개 항목. 줄바꿈으로 구분, 기호 사용 없음.
- 라벨 예시(흐름에 맞게 자유 선택): 현상 파악 / 로그 분석 / 근본 원인 규명 / 설계 의도 확인 / 지원 범위 확인 / 세부 지표 확인 / 특성 고려 / TAC 권고사항 / 추가 안내 / 엔지니어링 대응 확인 / 적용 방향 / 후속 조치 방향
- 첫 항목 라벨이 "1차 검토 결과"일 필요는 없다.
- 분석 대상 컴포넌트, 설정 항목은 항목 내에 직접 명시한다.
- CPU, Memory, Disk 등 수치는 별도 나열 없이 문장 안에 녹여 서술한다.
- 앞 항목의 결과가 다음 항목의 근거가 되도록 인과 흐름을 유지한다.
- 영문 용어 뒤 괄호 한국어 병기 지양. (예: Scope(범위) → Scope)
- 명사형 종결: ~함 / ~임 / ~필요 / ~권고 / ~안내받음

## 기재 금지 → 대체 서술
파일 경로, 파일명, 명령어, 코드 블록, 로그 문자열, 에러 클래스명은 직접 쓰지 않고 기능·역할 중심으로 대체한다.

| 금지 | 허용 |
|---|---|
| UAA 설정 파일 내 accessTokenValiditySeconds 항목 수정 | UAA 설정 파일 내 토큰 유효시간 항목을 직접 수정하는 방식 |
| MismatchedInputException 발생으로 HTTP 400 에러 연속 발생 | 버전 전환 중 데이터 구조 불일치로 인해 인스턴스 간 통신 오류가 연속 발생 |
| monit restart uaa 실행 후 즉시 적용 가능 | UAA 서비스 재기동을 통해 즉시 적용 가능 |

# 4. 최종 결과
- 진행 상황의 마지막 흐름을 한 문장으로 요약.
- 조치 완료 여부 + 고객 전달 여부를 반드시 포함.
- 종료된 케이스: "~을 확인하여 고객사에 전달 완료"
- 진행 중인 케이스: "~을 기반으로 단계적 조치 예정"

# 참고 예시 (질의 내용 작성 스타일)
운영 중인 7개 TAS 환경에서 일부 컴포넌트의 리소스 과다 사용 및 저부하 컴포넌트의 자원 낭비 관찰. 플랫폼 정밀 진단 및 효율적인 자원 조정 기준 필요

KPI/KCSI 기반 리소스 사용 적정성 검토

저부하 컴포넌트에 대한 스케일 다운 전략 및 내부 기준 수립 가이드 요청

Gemfire 등 부가 서비스 타일의 리소스 사용량 점검`;

const USER_INSTRUCTION = "위 SR 내역을 지침에 따라 보고서로 정리해라.";

/** 케이스 본문을 보낼 수 있는 키가 있는가. */
export function hasSrReporter(): boolean {
  return (process.env.OPENAI_API_KEY ?? "").trim() !== "";
}

function readCached(requestId: number): SrReport | null {
  const db = openDb();
  try {
    const rows = db
      .prepare("SELECT content FROM case_summaries WHERE request_id = ? AND kind = 'ppt'")
      .all(requestId) as unknown as Array<{ content: string }>;
    const row = rows[0];
    return row === undefined ? null : parseSrReport(row.content);
  } finally {
    db.close();
  }
}

function writeCached(requestId: number, raw: string): void {
  const db = openDb();
  try {
    db.prepare(
      `INSERT INTO case_summaries (request_id, kind, content, source, generated_at)
       VALUES (?, 'ppt', ?, 'ai', ?)
       ON CONFLICT(request_id, kind) DO UPDATE SET
         content = excluded.content,
         source = excluded.source,
         generated_at = excluded.generated_at`,
    ).run(requestId, raw, isoNow());
  } finally {
    db.close();
  }
}

/**
 * 케이스 하나의 보고서를 얻는다.
 * 저장된 것이 있으면 그대로 쓰고, force 를 주면 다시 만든다.
 */
export async function getSrReport(
  requestId: number,
  force = false,
): Promise<SrReport & { cached: boolean }> {
  if (!force) {
    const cached = readCached(requestId);
    if (cached !== null) return { ...cached, cached: true };
  }
  if (!hasSrReporter()) {
    throw new SrReportError(0, ".env 에 OPENAI_API_KEY 가 필요합니다.");
  }

  const detail = getCase(requestId);
  if (detail === null) throw new SrReportError(404, "케이스를 찾을 수 없습니다.");

  const source = buildSourceText({
    requestId: detail.request_id_formatted,
    subject: detail.subject,
    status: detail.status,
    priority: detail.priority,
    product: detail.category,
    createdOn: detail.created_on,
    closedOn: detail.last_updated,
    description: detail.description_text,
    threads: listThreads(requestId).map((t) => ({
      isOurs: t.is_ours === 1,
      at: t.res_date_val,
      body: t.body_text,
    })),
  });

  const raw = await chat(SYSTEM_PROMPT, `${source}

${USER_INSTRUCTION}`, { maxTokens: 2000 });
  writeCached(requestId, raw);
  return { ...parseSrReport(raw), cached: false };
}
