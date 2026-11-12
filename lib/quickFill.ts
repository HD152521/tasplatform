/**
 * 간단히 올리기가 만들어 준 값 — **작성 폼에 채워 넣을 한 덩어리.**
 *
 * ## 왜 모달에서 끝내지 않나
 *
 * 전에는 정리 결과를 모달 안에서 `<pre>` 로 보여 주고 거기서 올렸다. 그 화면에서는
 * **고칠 수가 없었다.** AI 가 쓴 글이 거의 맞는데 한 줄만 고치고 싶을 때 길이 없어서,
 * 취소하고 작성 폼에 처음부터 다시 적어야 했다. 그래서 결과를 모달에 그리지 않고
 * 작성 폼에 **입력된 상태로** 채운다 — 거기에는 이미 모든 칸이 입력칸으로 있다.
 *
 * ## 왜 파싱을 여기 두나
 *
 * 서버 응답을 **검사해서** 받는다. `?? 0` 으로 메우면 productId 0 으로 등록을 시도하고,
 * 그 실패 원인은 포털 응답까지 가서야 드러난다. 이 판정이 틀려도 화면은 멀쩡해 보이므로
 * (칸이 채워져 있고 값만 틀렸다) 순수 함수로 떼어 단위시험으로 잠근다.
 */

/** 작성 폼이 받아 채우는 값. 전부 사람이 고칠 수 있다. */
export interface QuickFill {
  /** 담당자가 적은 메모 원문. Jira 본문·제목·구분의 바탕이 된다. */
  readonly memo: string;
  readonly subject: string;
  readonly content: string;
  readonly severity: string;
  readonly productId: number;
  readonly productName: string;
  readonly componentId: number;
  readonly componentName: string;
  /** 글에서 찾은 릴리스. 못 찾으면 0 이고, 그때는 사람이 골라야 올라간다. */
  readonly releaseId: number;
  readonly releaseDesc: string;
  readonly titleKo: string;
  readonly jiraBody: string;
  /** 원문에 없어 담당자가 채워야 할 것들. */
  readonly missing: readonly string[];
  /** 왜 그 Product · Component 를 골랐는가. */
  readonly reason: string;
  /** 기본값으로 떨어졌는가. 참이면 AI 가 고른 것이 아니다. */
  readonly fallback: boolean;
  /** 본문이 끝까지 모자랐을 때의 한 줄(lib/srDraftQuality.ts). 괜찮으면 빈 문자열. */
  readonly warning: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const posInt = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;

/**
 * 서버 응답을 QuickFill 로 읽는다. 모양이 어긋나면 null.
 *
 * 제목·본문·제품·컴포넌트는 **없으면 올릴 수 없는 값**이라 하나라도 빠지면 거부한다.
 * 버전은 없어도 올릴 수 있으므로(화면에서 고른다) 거부 조건에 넣지 않는다.
 */
export function parseQuickFill(
  body: Record<string, unknown>,
  memo: string,
  severity: string,
): QuickFill | null {
  const subject = str(body.subject).trim();
  const content = str(body.content).trim();
  const productId = posInt(body.productId);
  const componentId = posInt(body.componentId);
  if (subject === "" || content === "" || productId === 0 || componentId === 0) return null;

  return {
    memo,
    subject,
    content,
    severity,
    productId,
    productName: str(body.productName),
    componentId,
    componentName: str(body.componentName),
    releaseId: posInt(body.releaseId),
    releaseDesc: str(body.releaseDesc),
    titleKo: str(body.jiraTitle).trim(),
    jiraBody: str(body.jiraBody).trim(),
    missing: Array.isArray(body.missing)
      ? body.missing.map(str).filter((m) => m.trim() !== "")
      : [],
    reason: str(body.reason).trim(),
    // 모르면 **폴백으로 본다.** 경고를 띄우고 마는 쪽이, 조용히 "AI 가 골랐다" 고
    // 보여 주는 쪽보다 낫다.
    fallback: body.fallback !== false,
    warning: str(body.warning).trim(),
  };
}

/**
 * 채워 넣은 뒤 **사람이 봐야 할 것들**을 줄로 만든다.
 *
 * 채워 두고 조용히 있으면 사람은 AI 가 다 맞게 골랐다고 본다. 틀릴 수 있는 자리를
 * 이름으로 짚어 준다 — 어차피 칸은 바로 위에 입력칸으로 있으니 고치면 된다.
 *
 * `comboKnown` 은 고른 Product · Component 조합이 **화면의 목록에 있는가**다. 없으면
 * 선택 칸은 다른 값을 보여 주는데(첫 항목으로 떨어진다) 사람은 AI 가 고른 값이라고
 * 믿는다. 그대로 올라가면 Broadcom 쪽에서 엉뚱한 팀으로 간다.
 */
export function quickFillNotes(fill: QuickFill, comboKnown: boolean): string[] {
  const notes: string[] = [];
  if (!comboKnown) {
    notes.push(
      `AI 가 고른 Product · Component (${fill.productName} / ${fill.componentName}) 가`
      + " 목록에 없습니다. 직접 골라주세요.",
    );
  } else if (fill.fallback) {
    notes.push(
      "어떤 Product · Component 인지 정하지 못해 가장 많이 쓴 조합으로 두었습니다."
      + " 맞는지 보고 고쳐주세요.",
    );
  }
  if (fill.releaseId === 0) {
    notes.push("글에서 버전을 찾지 못했습니다. Prod Release 를 골라야 올릴 수 있습니다.");
  }
  if (fill.warning !== "") notes.push(fill.warning);
  if (fill.missing.length > 0) {
    notes.push(
      `원문에 없어 못 채운 것이 있습니다 — ${fill.missing.join(" / ")}.`
      + " 그대로 올리면 Broadcom 이 되묻습니다.",
    );
  }
  return notes;
}
