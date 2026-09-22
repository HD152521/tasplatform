/**
 * 기술문서가 우리 환경에 걸리는지 판정하는 프롬프트.
 *
 * 앞단에서 product-chip 으로 제품은 이미 걸렀다. 여기서 보는 것은 그 다음이다 —
 * 같은 제품이라도 우리가 안 쓰는 구성요소·배포형태·버전 이야기면 우리 일이 아니다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서 부른다.
 */
import { KB_SECTIONS, type KbArticle } from "./kb.ts";

export type KbVerdict = "match" | "maybe" | "no";

export const VERDICT_LABEL: Readonly<Record<KbVerdict, string>> = {
  match: "관련 있음",
  maybe: "확인 필요",
  no: "관련 없음",
};

/**
 * 우리 환경 설명. 판정의 기준이 되는 유일한 근거다.
 *
 * 버전을 적어두지 않았다. 지금 확정된 값이 없어서다 — 아는 대로 채우면 판정이
 * 그만큼 날카로워진다. KB_ENV_PROFILE 환경변수로 배포마다 덮어쓸 수 있다.
 */
export const ENV_PROFILE_DEFAULT = `우리가 운영·지원하는 환경:
- VMware Tanzu Platform - Cloud Foundry (TAS, Tanzu Application Service) — 주력
- Tanzu Operations Manager, BOSH Director 로 배포·운영
- TAS 내장 구성요소: Diego, Gorouter, UAA, CredHub, Loggregator
- 온디맨드 서비스: RabbitMQ, GemFire(Tanzu Data Suite), Spring Cloud Gateway
- Tanzu Platform Core / Tanzu Hub, Healthwatch
- 고객사는 금융권(NH농협은행·NH농협중앙회)이라 인터넷이 막힌 폐쇄망이다.
- 개발·운영·DR 세 환경을 나눠 운영한다.

우리가 쓰지 않는 것(문서가 이쪽 이야기면 관련 없음):
- vSphere/ESXi/vCenter/NSX/VCF 자체 운영, SDDC Manager
- SiteMinder, Clarity, Automic, Symantec, DX/Nimsoft UIM, Spectrum 계열
- Greenplum, TKGI/TKG 등 Kubernetes 런타임 전용 기능
- 퍼블릭 클라우드 전용(SaaS·FedRAMP) 구성

버전은 확정해 두지 않았다. 판정이 특정 버전에 걸리면 '관련 없음'으로 단정하지 말고
'확인 필요'로 두고 어떤 버전을 확인해야 하는지 적는다.`;

/** 배포마다 덮어쓸 수 있게 한다. 비어 있으면 기본값. */
export function envProfile(): string {
  const override = (process.env.KB_ENV_PROFILE ?? "").trim();
  return override === "" ? ENV_PROFILE_DEFAULT : override;
}

export const RELEVANCE_SYSTEM_PROMPT = `당신은 Broadcom Tanzu/TAS 운영팀의 기술지원 담당자입니다.
Broadcom 기술문서 한 건을 읽고, 그 문서가 우리 환경에서 실제로 일어날 수 있는 문제인지 판정합니다.

판정값은 셋 중 하나입니다.
- match : 우리 환경에서 일어날 수 있다. 지금 알아둘 가치가 있다.
- maybe : 제품은 맞지만 구성·버전·배포형태를 확인해야 한다.
- no    : 우리가 쓰지 않는 구성요소·배포형태 이야기다.

지켜야 할 것:
- 근거는 문서에 적힌 내용과 아래 환경 설명에서만 가져옵니다. 추측으로 채우지 않습니다.
- 문서의 Environment 섹션에 적힌 제품·버전을 우리 환경과 대조하는 것이 핵심입니다.
- 모르면 match 나 no 로 밀지 말고 maybe 로 두고, 무엇을 확인해야 하는지 적습니다.
- 이유는 한국어 한 문장으로, 담당자가 바로 이해할 수 있게 씁니다.

출력은 아래 두 줄만 내보냅니다. 다른 말은 붙이지 않습니다.
판정: match|maybe|no
이유: (한국어 한 문장)`;

/** 문서를 프롬프트에 실을 형태로 편다. 본문이 길면 잘라 토큰을 아낀다. */
export function buildRelevanceUser(
  article: Pick<KbArticle, "title" | "products" | "sections">,
  perSectionLimit = 1200,
): string {
  const parts = [
    `[우리 환경]\n${envProfile()}`,
    `[문서 제목]\n${article.title}`,
    `[문서 제품 태그]\n${article.products.join(", ")}`,
  ];
  for (const name of KB_SECTIONS) {
    const body = article.sections.get(name);
    if (body === undefined || body.trim() === "") continue;
    const text = body.length > perSectionLimit ? `${body.slice(0, perSectionLimit)}…` : body;
    parts.push(`[${name}]\n${text}`);
  }
  return parts.join("\n\n");
}

/**
 * 모델 응답에서 판정과 이유를 뽑는다.
 *
 * 형식을 조금 어겨도(코드펜스, 라벨 누락, 영어 라벨) 건지도록 너그럽게 읽는다.
 * 판정을 못 읽으면 maybe 로 둔다 — 모르는 것을 관련 없음으로 버리면 놓친다.
 */
export function parseVerdict(text: string): { verdict: KbVerdict; why: string } {
  const clean = text.replace(/```[a-z]*|```/gi, "").trim();
  const verdictLine = /(?:판정|verdict)\s*[:：]\s*([A-Za-z]+)/i.exec(clean)?.[1] ?? "";
  const lowered = verdictLine.toLowerCase();
  const verdict: KbVerdict =
    lowered === "match" || lowered === "no" || lowered === "maybe" ? lowered : "maybe";

  let why = (/(?:이유|reason)\s*[:：]\s*([\s\S]+)/i.exec(clean)?.[1] ?? "").trim();
  if (why === "") {
    // 라벨을 통째로 빠뜨린 경우. 판정 줄이 아닌 첫 줄을 이유로 본다.
    why = clean
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !/^(판정|verdict)\s*[:：]/i.test(l)) ?? "";
  }
  return { verdict, why: why.split("\n")[0]?.trim() ?? "" };
}
