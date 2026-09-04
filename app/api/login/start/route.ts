import { NextResponse } from "next/server";
import { startLogin } from "../../../../lib/loginFlow.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "error", message: "잘못된 요청입니다." }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (username === "" || password === "") {
    return NextResponse.json(
      { status: "error", message: "아이디와 비밀번호를 모두 입력하세요." },
      { status: 400 },
    );
  }

  // 자격증명은 여기서만 쓰이고 저장되지 않는다. 로그에도 남기지 않는다.
  const result = await startLogin(username, password);
  return NextResponse.json(result);
}
