/**
 * 메신저 웹훅 알림.
 *
 * 새 답변이 왔을 때, 그리고 수집이 실패했을 때 보낸다.
 * 실패를 알리는 쪽이 더 중요하다 — 조용히 멈춰 있으면 팀은 "답변이 없구나"
 * 로 오해한다. 이 도구가 처음부터 지켜 온 원칙이다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부르기 때문이다.
 */

export type WebhookKind = "slack" | "teams" | "discord" | "json";

/** 주소를 보고 형식을 고른다. SR_WEBHOOK_KIND 로 직접 지정할 수도 있다. */
export function detectKind(url: string): WebhookKind {
  const fixed = (process.env.SR_WEBHOOK_KIND ?? "").trim().toLowerCase();
  if (fixed === "slack" || fixed === "teams" || fixed === "discord" || fixed === "json") {
    return fixed;
  }
  if (url.includes("hooks.slack.com")) return "slack";
  if (url.includes("webhook.office.com") || url.includes("logic.azure.com")) return "teams";
  if (url.includes("discord.com/api/webhooks")) return "discord";
  return "json";
}

/** 메신저마다 본문 필드가 다르다. 그것만 맞춰 준다. */
export function buildPayload(kind: WebhookKind, text: string): Record<string, unknown> {
  switch (kind) {
    case "slack":
      return { text };
    case "discord":
      return { content: text };
    case "teams":
      // MessageCard 는 줄바꿈을 두 번 써야 실제로 줄이 바뀐다.
      return {
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        summary: text.split("\n")[0] ?? "Broadcom SR",
        text: text.replace(/\n/g, "\n\n"),
      };
    default:
      return { text };
  }
}

export interface ReplyLine {
  caseLabel: string;
  subject: string;
  requestId?: number;
  /** 답변 요점 한두 문장. lib/replySummary.ts 가 만든다. 없으면 제목·링크만 나간다. */
  summary?: string;
}

/**
 * 한 번에 몇 건까지 본문에 적을지.
 *
 * 요약을 만드는 쪽도 이 수만큼만 호출하면 되므로 수집기가 이 값을 읽어 간다.
 * (알림에 안 들어갈 건을 요약하는 것은 돈과 시간 낭비다)
 */
export const REPLY_LIMIT = 10;

function appUrl(): string {
  return (process.env.SR_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * 새 답변 알림 본문.
 *
 * 케이스 번호·제목 · 요점 한두 문장 · 링크. 이 세 줄이 한 건이다.
 * 요점까지 담는 이유는, 제목만으로는 지금 대응해야 할 답변인지
 * 화면을 열어 봐야만 알 수 있기 때문이다. 전문은 링크에서 읽는다.
 * 건수가 많으면 앞의 몇 건만 적고 나머지는 수만 밝힌다.
 */
export function formatReplies(replies: readonly ReplyLine[], limit = REPLY_LIMIT): string {
  const lines: string[] = [`Broadcom 새 답변 ${replies.length}건`];

  for (const reply of replies.slice(0, limit)) {
    lines.push("");
    lines.push(`[${reply.caseLabel}] ${reply.subject}`);
    if ((reply.summary ?? "").trim() !== "") {
      lines.push(reply.summary!.trim());
    }
    if (reply.requestId !== undefined) {
      lines.push(`${appUrl()}/cases/${reply.requestId}`);
    }
  }

  if (replies.length > limit) {
    lines.push("");
    lines.push(`… 외 ${replies.length - limit}건 — ${appUrl()}`);
  }
  return lines.join("\n");
}

/** 수집 실패 알림 본문. '새 답변 없음'과 헷갈리지 않게 못박는다. */
export function formatFailure(kind: "session" | "failed", detail: string): string {
  const head = kind === "session"
    ? "Broadcom 수집 중단 — 세션 만료"
    : "Broadcom 수집 실패";
  const lines = [
    head,
    "",
    "이번 회차는 조회하지 못했습니다. '새 답변 없음'이 아닙니다.",
    detail.trim() === "" ? "" : `사유: ${detail.slice(0, 300)}`,
  ].filter((line) => line !== "");

  if (kind === "session") {
    lines.push("");
    lines.push(`다시 로그인해 주세요: ${appUrl()}/login`);
  }
  return lines.join("\n");
}

export function hasWebhook(): boolean {
  return (process.env.SR_WEBHOOK_URL ?? "").trim() !== "";
}

/**
 * 실제 전송.
 *
 * 알림 실패가 수집을 망치면 안 되므로 예외를 밖으로 던지지 않는다.
 * 대신 무슨 일이 있었는지 반환해서 부르는 쪽이 로그에 남긴다 — 조용히 삼키지 않는다.
 */
export async function send(text: string): Promise<{ ok: boolean; detail: string }> {
  const url = (process.env.SR_WEBHOOK_URL ?? "").trim();
  if (url === "") return { ok: false, detail: "SR_WEBHOOK_URL 이 없습니다." };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(detectKind(url), text)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      return { ok: false, detail: `HTTP ${response.status} ${body}` };
    }
    return { ok: true, detail: "" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
