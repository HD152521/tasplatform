import { NextResponse } from "next/server";
import type { EnvCount, InstanceInput, PreviousMonth } from "../../../../lib/instanceCount.ts";
import { findPrevious, isMonth, saveMonth } from "../../../../lib/instanceStore.ts";
import { EMPTY_PREVIOUS } from "../../../../lib/instanceCount.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 화면에서 온 값은 믿지 않는다. 음수·NaN·문자열이 그대로 DB 로 들어가면 안 된다. */
function readEnv(value: unknown): EnvCount | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["dev", "prod", "dr"]) {
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || n < 0) return null;
    out[key] = n;
  }
  return out as unknown as EnvCount;
}

function readInput(value: unknown): InstanceInput | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const bank = readEnv(raw["bank"]);
  const central = readEnv(raw["central"]);
  const shared = readEnv(raw["shared"]);
  if (bank === null || central === null || shared === null) return null;
  return { bank, central, shared };
}

const PREV_KEYS: ReadonlyArray<keyof PreviousMonth> = [
  "bankProd", "bankProdShared", "bankDev", "bankDevShared", "centralProd", "centralDev",
];

function readPrevious(value: unknown): PreviousMonth | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of PREV_KEYS) {
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || n < 0) return null;
    out[key] = n;
  }
  return out as unknown as PreviousMonth;
}

export async function POST(request: Request) {
  let body: { month?: unknown; input?: unknown; previous?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  if (!isMonth(body.month)) {
    return NextResponse.json(
      { ok: false, message: "대상 월이 올바르지 않습니다 (YYYY-MM)." },
      { status: 400 },
    );
  }

  const input = readInput(body.input);
  if (input === null) {
    return NextResponse.json(
      { ok: false, message: "인스턴스 수는 0 이상의 숫자여야 합니다." },
      { status: 400 },
    );
  }

  // 앞선 달이 저장돼 있으면 그 결과가 기준이다. 화면이 보낸 값보다 우선한다 —
  // 저장된 계산 결과를 화면 값으로 덮어쓸 이유가 없다.
  const earlier = findPrevious(body.month);
  let previous: PreviousMonth;
  if (earlier !== null) {
    previous = earlier.containers;
  } else if (body.previous === null || body.previous === undefined) {
    previous = EMPTY_PREVIOUS;
  } else {
    const manual = readPrevious(body.previous);
    if (manual === null) {
      return NextResponse.json(
        { ok: false, message: "전월 인스턴스 수는 0 이상의 숫자여야 합니다." },
        { status: 400 },
      );
    }
    previous = manual;
  }

  try {
    const saved = saveMonth(body.month, input, previous);
    return NextResponse.json({ ok: true, savedAt: saved.savedAt });
  } catch (error) {
    // 저장 실패를 성공처럼 보이게 하지 않는다.
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message: `저장 실패: ${message}` }, { status: 500 });
  }
}
