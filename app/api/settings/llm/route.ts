import { NextResponse } from "next/server";
import { DEFAULT_TEAM_ID } from "../../../../lib/config.ts";
import { openDb, recordAudit } from "../../../../lib/db.ts";
import { hasSecretKey, MissingSecretKeyError } from "../../../../lib/secretBox.ts";
import { clearTokenCache } from "../../../../lib/llmClient.ts";
import {
  deleteLlmConfig,
  getLlmConfigMeta,
  upsertLlmConfig,
  type LlmAuthKind,
} from "../../../../lib/llmConfig.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readActor(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function coerceAuthKind(value: unknown): LlmAuthKind {
  return value === "bearer" || value === "none" || value === "client_credentials" ? value : "keycloak";
}

/** 현재 LLM 설정(마스킹) + 암호화 키 유무. 평문·암호문은 반환하지 않는다. */
export async function GET() {
  const db = await openDb();
  try {
    const config = await getLlmConfigMeta(db);
    return NextResponse.json({
      ok: true,
      config,
      hasSecretKey: hasSecretKey(),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 500 });
  } finally {
    await db.close();
  }
}

/** 등록/수정. secret(비밀번호/API 키)을 비워 보내면 기존 값을 유지한다. */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const numOr = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const actor = readActor(body.actor);

  const db = await openDb();
  try {
    await upsertLlmConfig(db, {
      name: str(body.name),
      modelId: str(body.modelId),
      baseUrl: str(body.baseUrl),
      authKind: coerceAuthKind(body.authKind),
      tokenUrl: str(body.tokenUrl),
      clientId: str(body.clientId),
      authUsername: str(body.authUsername),
      secret: str(body.secret),
      chatPath: str(body.chatPath),
      maxTokens: numOr(body.maxTokens, 512),
      temperature: numOr(body.temperature, 0.1),
      systemPrompt: str(body.systemPrompt),
    });
    // 시크릿을 회전해도 tokenUrl/clientId/username 이 같으면 캐시된 옛 토큰이 만료까지 쓰인다.
    // 저장 직후 캐시를 비워 새 자격이 즉시 반영되게 한다.
    clearTokenCache();
    await recordAudit(db, {
      actor, teamId: DEFAULT_TEAM_ID, action: "llm_upsert", requestId: null,
      result: "ok", detail: `model=${str(body.modelId)}`,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const code = error instanceof MissingSecretKeyError ? "no_key" : "error";
    await recordAudit(db, {
      actor, teamId: DEFAULT_TEAM_ID, action: "llm_upsert", requestId: null,
      result: `failed:${code}`, detail: `model=${str(body.modelId)}`,
    });
    if (error instanceof MissingSecretKeyError) {
      return NextResponse.json({ ok: false, message: error.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 400 });
  } finally {
    await db.close();
  }
}

/** 삭제(단일 설정). */
export async function DELETE(request: Request) {
  const actor = readActor(new URL(request.url).searchParams.get("actor"));
  const db = await openDb();
  try {
    await deleteLlmConfig(db);
    await recordAudit(db, {
      actor, teamId: DEFAULT_TEAM_ID, action: "llm_delete", requestId: null,
      result: "ok", detail: "",
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 500 });
  } finally {
    await db.close();
  }
}
