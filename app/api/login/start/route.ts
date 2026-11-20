import { NextResponse } from "next/server";
import { actorOf, userFromRequest } from "../../../../lib/appAuth.ts";
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
  // **그 사람의 팀**으로 로그인한다. 세션 파일·기기신뢰·자격 저장이 모두 팀별이라
  // (lib/config.ts sessionFileForTeam), 팀을 안 넘기면 2번 팀 사람이 로그인해도
  // 1번 팀 세션 자리에 덮어써 1번 팀 수집을 깨뜨린다.
  const me = await userFromRequest(request).catch(() => null);
  if (me === null) {
    return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
  }
  if (me.teamId === "") {
    return NextResponse.json({ ok: false, message: "속한 팀이 없습니다." }, { status: 400 });
  }

  const result = await startLogin(username, password, me.teamId, {
    remember: body.remember === true,
    actor: actorOf(me),
  });
  return NextResponse.json(result);
}
