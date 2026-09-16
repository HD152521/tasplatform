import { NextResponse } from "next/server";
import { DEFAULT_TEAM_ID } from "../../../../../lib/config.ts";
import { openDb, recordAudit } from "../../../../../lib/db.ts";
import {
  getLlmConfig,
  DEFAULT_CHAT_PATH,
  type LlmAuthKind,
  type LlmConfig,
} from "../../../../../lib/llmConfig.ts";
import { testConnection } from "../../../../../lib/llmClient.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function coerceAuthKind(value: unknown): LlmAuthKind {
  return value === "bearer" || value === "none" ? value : "keycloak";
}

/**
 * 연결 테스트. 화면에 입력한 값으로 즉시 시험한다(저장하지 않는다).
 * 비밀번호를 비워 보내면(수정 화면) 저장된 값을 꺼내 쓴다.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const numOr = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const db = await openDb();
  try {
    let secret = typeof body.secret === "string" ? body.secret : "";
    if (secret.trim() === "") {
      // 입력 없음 → 저장된 비밀번호(있으면)를 쓴다.
      const stored = await getLlmConfig(db);
      secret = stored?.secret ?? "";
    }

    const config: LlmConfig = {
      name: str(body.name),
      modelId: str(body.modelId),
      baseUrl: str(body.baseUrl).replace(/\/+$/, ""),
      authKind: coerceAuthKind(body.authKind),
      tokenUrl: str(body.tokenUrl),
      clientId: str(body.clientId),
      authUsername: str(body.authUsername),
      secret,
      chatPath: str(body.chatPath) || DEFAULT_CHAT_PATH,
      maxTokens: numOr(body.maxTokens, 512),
      temperature: numOr(body.temperature, 0.1),
      systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : "",
      updatedAt: "",
      source: "db",
    };

    if (config.modelId === "" || config.baseUrl === "") {
      return NextResponse.json(
        { ok: false, message: "모델 ID 와 API 기본 주소가 필요합니다." },
        { status: 400 },
      );
    }

    const result = await testConnection(config);
    await recordAudit(db, {
      actor: "", teamId: DEFAULT_TEAM_ID, action: "llm_test", requestId: null,
      result: result.ok ? "ok" : "failed:error", detail: `model=${config.modelId}`,
    });
    return NextResponse.json({ ok: result.ok, detail: result.detail });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    await db.close();
  }
}
