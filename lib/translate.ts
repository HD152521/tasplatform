/**
 * 한국어 번역.
 *
 * ⚠ 이 모듈은 텍스트를 외부로 보낸다.
 *   지금 쓰는 곳은 CVE 설명뿐이다 — NVD 가 공개한 텍스트라 고객사 정보가 없다.
 *
 *   케이스 본문·답변은 절대 여기로 보내지 말 것. 고객사(금융권) 인프라 구성이
 *   들어 있고, 무료 티어는 입력이 학습에 쓰일 수 있다. 그쪽은 로컬 모델을 쓴다.
 *
 * 제공자는 키가 있는 것을 쓴다. 한도(429)에 걸리면 다음 제공자로 넘어간다.
 * SR_TRANSLATE_PROVIDER 로 하나만 고정할 수도 있다 (gemini | groq).
 */
export interface Translated {
  /** 원문을 그대로 옮긴 번역. 대조용이라 늘리거나 줄이지 않는다. */
  translation: string;
}

export type Provider = "gemini" | "groq";

export class TranslateError extends Error {
  readonly status: number;
  readonly provider: string;
  /** 서버가 알려준 재시도 대기 시간(ms). 모르면 0. */
  readonly retryAfterMs: number;

  constructor(provider: string, status: number, detail: string, retryAfterMs = 0) {
    super(`번역 실패 (${provider}): HTTP ${status} ${detail}`.trim());
    this.name = "TranslateError";
    this.status = status;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * 429 응답이 알려주는 대기 시간.
 *
 * Groq 의 한도는 분당 토큰이라 보통 몇 초 뒤면 풀린다. 그 값을 읽어두면
 * "한도 걸림 = 오늘은 끝" 으로 오해하지 않고 기다렸다 이어갈 수 있다.
 * "12", "16.395s", "1m30s" 를 모두 받는다.
 */
function retryAfterFrom(headers: Headers): number {
  const raw = (headers.get("retry-after") ?? headers.get("x-ratelimit-reset-tokens") ?? "").trim();
  const match = raw.match(/^(?:(\d+(?:\.\d+)?)m)?(\d+(?:\.\d+)?)s?$/);
  if (match === null) return 0;
  const total = Number.parseFloat(match[1] ?? "0") * 60 + Number.parseFloat(match[2] ?? "0");
  return Number.isFinite(total) && total > 0 ? Math.ceil(total * 1000) : 0;
}

const PROMPT = [
  "다음은 보안 취약점(CVE) 설명이다. 한국어로 옮겨라.",
  "",
  "- 문장을 늘리거나 줄이지 않는다. 원문에 없는 내용을 추가하지 않는다.",
  "- 제품명, 버전, 함수명, CVE 번호, 기술 용어(buffer overflow 등)는 원문 그대로 둔다.",
  "- 담당 엔지니어가 읽는 문서다. 자연스러운 기술 문서체로 쓴다.",
  "- JSON 객체 하나만 출력한다: {\"translation\": \"...\"}",
  "",
  "원문:",
].join("\n");

function keyOf(provider: Provider): string {
  const raw = provider === "gemini" ? process.env.GEMINI_API_KEY : process.env.GROQ_API_KEY;
  return (raw ?? "").trim();
}

/** 키가 있고, 고정 설정에 어긋나지 않는 제공자들. 앞에 있는 것부터 쓴다. */
export function availableProviders(): Provider[] {
  const fixed = (process.env.SR_TRANSLATE_PROVIDER ?? "").trim().toLowerCase();
  const all: Provider[] = ["gemini", "groq"];
  const usable = all.filter((p) => keyOf(p) !== "");
  if (fixed === "gemini" || fixed === "groq") {
    return usable.filter((p) => p === fixed);
  }
  return usable;
}

export function hasTranslator(): boolean {
  return availableProviders().length > 0;
}

function parseResult(provider: string, status: number, out: string): Translated {
  // 모델이 코드펜스를 붙이는 경우가 있어 걷어낸다.
  const json = out.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let result: { translation?: unknown };
  try {
    result = JSON.parse(json) as typeof result;
  } catch {
    // JSON 형식이 아니면 응답 전체를 번역으로 본다. 버리지 않는다.
    return { translation: out.trim() };
  }
  const translation = typeof result.translation === "string" ? result.translation.trim() : "";
  if (translation === "") throw new TranslateError(provider, status, "번역 결과가 비어 있습니다.");
  return { translation };
}

async function viaGemini(text: string): Promise<Translated> {
  const key = keyOf("gemini");
  const model = process.env.SR_GEMINI_MODEL ?? "gemini-3.6-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${PROMPT}\n${text}` }] }],
        // 프롬프트로 부탁하면 마크다운 평문이 오는 경우가 있다. 스키마로 못박는다.
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { translation: { type: "STRING" } },
            required: ["translation"],
          },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );

  const raw = await response.text();
  if (!response.ok) {
    throw new TranslateError("gemini", response.status, raw.slice(0, 140), retryAfterFrom(response.headers));
  }

  let parsed: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new TranslateError("gemini", response.status, "응답을 해석하지 못했습니다.");
  }
  const out = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (out.trim() === "") throw new TranslateError("gemini", response.status, "빈 응답");
  return parseResult("gemini", response.status, out);
}

async function viaGroq(text: string): Promise<Translated> {
  const key = keyOf("groq");
  const model = process.env.SR_GROQ_MODEL ?? "openai/gpt-oss-120b";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: `${PROMPT}\n${text}` }],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new TranslateError("groq", response.status, raw.slice(0, 140), retryAfterFrom(response.headers));
  }

  let parsed: { choices?: Array<{ message?: { content?: string } }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new TranslateError("groq", response.status, "응답을 해석하지 못했습니다.");
  }
  const out = parsed.choices?.[0]?.message?.content ?? "";
  if (out.trim() === "") throw new TranslateError("groq", response.status, "빈 응답");
  return parseResult("groq", response.status, out);
}

const RUNNERS: Record<Provider, (text: string) => Promise<Translated>> = {
  gemini: viaGemini,
  groq: viaGroq,
};

/**
 * 한국어로 옮기고 정리한다.
 *
 * 한도(429)나 일시적 서버 오류(5xx)면 다음 제공자로 넘어간다.
 * 그 외 오류는 그대로 올린다 — 키가 틀린 것을 조용히 넘기면 안 된다.
 */
export async function translateToKorean(
  text: string,
): Promise<Translated & { provider: Provider }> {
  const providers = availableProviders();
  if (providers.length === 0) {
    throw new TranslateError("none", 0, "GEMINI_API_KEY 또는 GROQ_API_KEY 가 필요합니다.");
  }

  let last: unknown;
  for (const provider of providers) {
    try {
      return { ...(await RUNNERS[provider](text)), provider };
    } catch (error) {
      last = error;
      const status = error instanceof TranslateError ? error.status : 0;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable) throw error;
    }
  }
  throw last;
}
