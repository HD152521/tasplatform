/**
 * 이 앱의 절대 주소. 알림·외부 글에 넣는 "돌아올 링크" 의 앞부분이다.
 *
 * 같은 한 줄이 세 곳에 있었다(알림 웹훅·Jira 본문·노션 페이지). 갈라지면 어떤 링크는
 * localhost 를 가리키고, 그걸 받은 사람은 눌러도 아무것도 열리지 않는다.
 * manifest.yml 이 세 앱 모두에 SR_APP_URL 을 넣어 둔다.
 *
 * **import 를 하나도 두지 않는다.** lib/notify.ts 가 의존성 없는 모듈로 유지되어야 해서다
 * (수집기에서도 부른다 — 거기서 .env 는 이미 읽혀 있다). config.ts 에 두면 그 한 줄이
 * dotenv 로드를 끌고 들어온다.
 */
export function appUrl(): string {
  return (process.env.SR_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}
