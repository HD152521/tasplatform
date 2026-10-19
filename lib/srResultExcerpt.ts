/**
 * 정리 문서에서 **결과 부분만** 뽑는다 — 순수 함수.
 *
 * Jira 티켓에 "이렇게 끝났습니다" 를 두세 줄로 남기려는 것이다. 문서 전체를 댓글에
 * 복사하면 아무도 읽지 않고, Confluence 링크가 있으니 그럴 필요도 없다.
 *
 * ## AI 를 다시 부르지 않는다
 *
 * 방금 만든 요약에 이미 결론이 들어 있다. 같은 내용으로 두 번 돈을 쓸 이유가 없고,
 * 자동 게시는 사람이 기다리지 않는 자리지만 한 회차에 여러 건을 돌므로 호출이 쌓인다.
 *
 * ## 섹션 **이름**으로 찾지 않는다
 *
 * 한때 Confluence 변환기가 "아는 섹션 이름 네 개" 만 헤딩으로 인식했다. 그 사이 요약
 * 프롬프트의 섹션 이름이 바뀌어 네 개가 하나도 안 맞게 됐고, 게시된 문서에 `### 문제`
 * 가 글자 그대로 찍혔다(lib/confluenceStorage.ts 머리말). 이름으로 판별하면 프롬프트가
 * 바뀔 때 **조용히** 깨진다.
 *
 * 그래서 **모양**으로 찾는다 — 마지막 헤딩의 본문이 결론이다. 섹션 이름이 무엇으로
 * 바뀌어도 "마지막 섹션" 은 따라온다. 캐시에 남아 있는 옛 모양의 요약에도 통한다.
 */

/** 댓글에 넣을 길이. 두세 줄이면 충분하고, 자세한 것은 링크가 맡는다. */
const MAX_CHARS = 400;

/** 몇 줄까지. 줄이 많으면 댓글이 문서를 베낀 꼴이 된다. */
const MAX_LINES = 4;

/** 헤딩 줄인가. 이름은 따지지 않는다(머리말 참고). */
function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line.trim());
}

/** 코드 블록을 여닫는 줄인가. */
function isFence(line: string): boolean {
  return /^\s*```/.test(line.trim());
}

/**
 * 코드 블록 **안**인 줄에 표시를 매긴다.
 *
 * 마지막 섹션(해결 제안·조치)은 명령과 설정을 코드 블록으로 옮기게 되어 있다
 * (lib/summaryPrompt.ts). 그 안에 셸 주석 `# systemctl restart ...` 가 있으면 헤딩으로
 * 오인되어, **마지막 헤딩이 그 줄로 옮겨간다.** 그러면 댓글에 명령 한두 줄과 닫는
 * 울타리만 들어간다. 반대로 코드 블록으로 시작하는 섹션은 ```` ```bash ```` 줄이
 * 평문으로 찍힌다.
 *
 * lib/summaryPrompt.ts 의 cleanSectionText 가 이미 같은 방식으로 울타리를 다룬다.
 */
function fenceMask(lines: readonly string[]): boolean[] {
  const inside: boolean[] = [];
  let open = false;
  for (const line of lines) {
    if (isFence(line)) {
      // 울타리 줄 자체도 "안" 으로 본다 — 평문으로 새 나가지 않게.
      inside.push(true);
      open = !open;
      continue;
    }
    inside.push(open);
  }
  return inside;
}

/**
 * 결과로 쓸 두세 줄.
 *
 * 헤딩이 하나도 없으면 **맨 끝 문단**을 쓴다. 요약이 어떤 모양이든 끝부분이 결론일
 * 가능성이 가장 높고, 빈 댓글을 남기는 것보다 낫다.
 */
export function resultExcerpt(summary: string, maxChars = MAX_CHARS): string {
  const lines = summary.replace(/\r\n/g, "\n").split("\n");

  // 마지막 헤딩 자리를 찾는다. 코드 블록 안의 `#` 은 주석이지 제목이 아니다.
  const inside = fenceMask(lines);
  let lastHeading = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!inside[i] && isHeading(lines[i] ?? "")) lastHeading = i;
  }

  /** 뽑아 쓸 줄들. 코드 블록 안은 버린다 — 댓글은 두세 줄 요약이지 명령 모음이 아니다. */
  const rows = lastHeading === -1
    // 헤딩이 없다 — 맨 끝 문단을 쓴다.
    ? (summary.replace(/\r\n/g, "\n").split(/\n{2,}/).filter((b) => b.trim() !== "").at(-1) ?? "")
      .split("\n")
    : lines.slice(lastHeading + 1).filter((_, i) => !inside[lastHeading + 1 + i]);

  const picked = rows
    .map((line) => line.trim())
    // 표는 가져오지 않는다. 댓글에서 파이프 줄은 읽히지 않는다.
    .filter((line) => line !== "" && !line.startsWith("|"))
    /*
     * 글머리 기호는 떼어낸다 — 댓글에서는 평문 줄로 둔다.
     *
     * 기호 **뒤에 공백을 요구한다.** 안 그러면 `**조치 방안:**` 이 `*조치 방안:**` 이
     * 되고 `--force` 가 `-force` 가 된다. 요약은 그런 모양을 자주 쓴다.
     */
    .map((line) => line.replace(/^[-*•]\s+/, ""))
    .slice(0, MAX_LINES);

  const text = picked.join("\n").trim();
  if (text.length <= maxChars) return text;

  // 자르되 **서러게이트 쌍을 쪼개지 않는다**(이모지가 경계에 걸리면 깨진 글자가 나간다).
  const cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  const safe = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return `${safe.trimEnd()}…`;
}
