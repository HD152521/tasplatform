/**
 * OpenAI 호출 구현부.
 *
 * ⚠ 케이스 본문이 외부로 나가는 통로다. 경로는 두 개다.
 *   (1) 뷰어에서 사람이 누를 때 만드는 SR 보고서 — lib/srReport.ts
 *   (2) 새 답변 알림에 붙는 한 줄 요약 — lib/replySummary.ts (15분마다 자동)
 *   고객사(금융권) 인프라 정보가 들어 있으므로 무료 티어에 보내면 안 된다.
 *   CVE 번역이 쓰는 lib/translate.ts (Gemini·Groq) 와 분리해 두고,
 *   여기서는 OPENAI_API_KEY 만 쓴다. 이 키를 다른 용도로 돌려쓰지 말 것.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부르기 때문이다.
 * 뷰어 쪽 진입점은 lib/openai.ts 이고 그쪽에 가드레일이 남아 있다.
 */

export class OpenAiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`OpenAI 호출 실패 (HTTP ${status}): ${detail}`.trim());
    this.name = "OpenAiError";
    this.status = status;
  }
}

export function hasOpenAi(): boolean {
  return (process.env.OPENAI_API_KEY ?? "").trim() !== "";
}

/**
 * system + user 한 번 주고받기.
 *
 * 형식 규칙을 지키게 하려면 temperature 를 낮게 두는 편이 안정적이다.
 * 실패는 던진다 — 빈 문서를 돌려주면 '만들어졌다'로 오해한다.
 *
 * 기본 타임아웃은 보고서 기준(3분)이다. 수집기처럼 기다릴 수 없는 쪽은
 * timeoutMs 를 줄여서 부른다.
 */
export async function chat(
  system: string,
  user: string,
  options: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (key === "") throw new OpenAiError(0, ".env 에 OPENAI_API_KEY 가 필요합니다.");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.SR_OPENAI_MODEL ?? "gpt-4o",
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 3000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
  });

  const raw = await response.text();
  if (!response.ok) throw new OpenAiError(response.status, raw.slice(0, 200));

  let parsed: { choices?: Array<{ message?: { content?: string } }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new OpenAiError(response.status, "응답을 해석하지 못했습니다.");
  }
  const out = parsed.choices?.[0]?.message?.content ?? "";
  if (out.trim() === "") throw new OpenAiError(response.status, "빈 응답");
  return out.trim();
}
