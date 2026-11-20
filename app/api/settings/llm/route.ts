import { NextResponse } from "next/server";
import { actorOf, userFromRequest } from "../../../../lib/appAuth.ts";
import { DEFAULT_TEAM_ID } from "../../../../lib/config.ts";
import { openDb, recordAudit } from "../../../../lib/db.ts";
import { hasSecretKey, MissingSecretKeyError } from "../../../../lib/secretBox.ts";
import { clearTokenCache } from "../../../../lib/llmClient.ts";
import {
  deleteLlmConfig,
  getLlmConfigMeta,
  listLlmConnections,
  newLlmId,
  setActiveLlmId,
  upsertLlmConfig,
  type LlmAuthKind,
} from "../../../../lib/llmConfig.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 감사 로그의 actor.
 *
 * **세션이 있으면 그 사람이다.** 본문/쿼리의 actor 는 호출자가 적어 보내는 값이고,
 * 화면은 그 칸을 비워 보내 왔다 — 공용 계정 비밀번호를 바꾼 기록에 사람 이름이
 * 없었다는 뜻이다. 세션이 없을 때만 예전처럼 받은 값을 쓴다(스크립트 호출 호환).
 */
async function resolveActor(request: Request, fallback: unknown): Promise<string> {
  const user = await userFromRequest(request).catch(() => null);
  if (user !== null) return actorOf(user);
  return typeof fallback === "string" ? fallback.trim() : "";
}

function coerceAuthKind(value: unknown): LlmAuthKind {
  return value === "bearer" || value === "none" || value === "client_credentials" ? value : "keycloak";
}

/**
 * 등록된 연결 전부(마스킹) + 지금 활성인 설정 + 암호화 키 유무.
 * 평문·암호문은 반환하지 않는다.
 *
 * `config` 를 그대로 남긴다 — 활성 연결의 메타다. 예전 응답 모양을 쓰는 호출부가
 * 깨지지 않게 하기 위해서고, 환경변수 폴백(연결이 0개)도 그 칸으로만 보인다.
 */
export async function GET() {
  const db = await openDb();
  try {
    return NextResponse.json({
      ok: true,
      config: await getLlmConfigMeta(db),
      connections: await listLlmConnections(db),
      hasSecretKey: hasSecretKey(),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 500 });
  } finally {
    await db.close();
  }
}

/**
 * 등록/수정/활성 전환.
 *
 * - `action: "activate"` + `llmId` → 활성 연결을 바꾼다.
 * - 그 밖에는 저장이다. `llmId` 를 주면 그 연결을 고치고, `new: true` 면 새로 만든다.
 *   둘 다 없으면 예전처럼 `default` 를 쓴다(연결이 하나뿐이던 시절의 화면 호환).
 * - secret(비밀번호/API 키)을 비워 보내면 기존 값을 유지한다.
 */
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
  const actor = await resolveActor(request, body.actor);

  const db = await openDb();
  try {
    if (body.action === "activate") {
      const llmId = str(body.llmId).trim();
      await setActiveLlmId(db, llmId);
      // 활성이 바뀌면 **토큰 캐시를 반드시 비운다.** 캐시는 연결별로 갈라져 있지
      // 않아서, 비우지 않으면 새 활성 연결이 **옛 연결의 토큰**으로 호출한다.
      clearTokenCache();
      await recordAudit(db, {
        actor, teamId: DEFAULT_TEAM_ID, action: "llm_activate", requestId: null,
        result: "ok", detail: `llm=${llmId}`,
      });
      return NextResponse.json({ ok: true, connections: await listLlmConnections(db) });
    }

    const llmId = body.new === true ? newLlmId() : str(body.llmId).trim() || undefined;

    const savedId = await upsertLlmConfig(db, {
      llmId,
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
      result: "ok", detail: `llm=${savedId} model=${str(body.modelId)}`,
    });
    return NextResponse.json({
      ok: true,
      llmId: savedId,
      connections: await listLlmConnections(db),
    });
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

/** 삭제. `?llmId=` 를 생략하면 예전처럼 `default` 를 지운다. */
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const actor = await resolveActor(request, url.searchParams.get("actor"));
  const llmId = (url.searchParams.get("llmId") ?? "").trim();

  const db = await openDb();
  try {
    await deleteLlmConfig(db, llmId === "" ? undefined : llmId);
    clearTokenCache();
    await recordAudit(db, {
      actor, teamId: DEFAULT_TEAM_ID, action: "llm_delete", requestId: null,
      result: "ok", detail: `llm=${llmId}`,
    });
    return NextResponse.json({ ok: true, connections: await listLlmConnections(db) });
  } catch (error) {
    // "활성 연결은 지울 수 없습니다" 는 사람이 고칠 수 있는 거절이므로 400 이다.
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 400 });
  } finally {
    await db.close();
  }
}
