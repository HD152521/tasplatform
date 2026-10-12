import { redirect } from "next/navigation";

/**
 * `/settings` → `/settings/llm`.
 *
 * 전에 이 자리에 "연동 설정" 화면이 있었다. **아무 일도 하지 않는 화면이었다** —
 * 입력을 `team_integrations` 테이블에 저장했지만 그 테이블을 읽는 코드가 없었고,
 * 실제 Jira 자격은 `atlassianConfig()` 가 환경변수에서만 읽는다(lib/atlassian.ts).
 * 게다가 Atlassian 은 `email:token` Basic 인증인데 그 테이블에 email 칸이 없어서,
 * 그 모양으로는 연결을 구동할 수조차 없었다 — 처음부터 미완성이었다.
 *
 * 그래서 걷어냈다. Jira 는 환경변수로만 설정한다(ATLASSIAN_BASE/EMAIL/TOKEN,
 * JIRA_PROJECT). 화면에서 바꿀 수 있게 하려면 email 칸을 포함한 스키마 변경과
 * `atlassianConfig()` 의 async 전환이 함께 필요하다 — 그때 다시 만들면 된다.
 *
 * 이 주소를 즐겨찾기에 둔 사람이 404 를 보지 않도록 리다이렉트만 남긴다.
 */
export default function SettingsRedirect(): never {
  redirect("/settings/llm");
}
