import { NextResponse } from "next/server";
import { startLogin } from "../../../../lib/loginFlow.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { username?: unknown; password?: unknown; remember?: unknown; actor?: unknown };
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

  // 자격증명은 로그에 남기지 않는다.
  //
  // remember 가 true 면 **로그인이 성공한 뒤에만** 암호화해 저장한다(자동 로그인용).
  // 실패한 비밀번호는 저장되지 않는다. 이게 없으면 비밀번호 회전마다 사람이 두 곳
  // (여기와 설정 화면)에 같은 값을 넣어야 하고, 한쪽을 잊으면 수집기가 옛 값으로
  // 계속 시도해 계정이 잠긴다.
  const result = await startLogin(username, password, undefined, {
    remember: body.remember === true,
    actor: typeof body.actor === "string" ? body.actor : "",
  });
  return NextResponse.json(result);
}
