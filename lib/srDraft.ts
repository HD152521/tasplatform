/**
 * SR 작성 화면이 쓰던 내용 — 모양과 복구 규칙만. 순수 함수.
 *
 * 화면(app/new/DraftForm.tsx)에서 떼어 둔 이유는 하나다: **보관해 둔 값을 되읽는
 * 규칙이 깨지면 작성 화면 자체가 열리지 않는다.** 그 규칙은 테스트로 잠가야 하고,
 * "use client" 가 붙은 tsx 는 node:test 로 불러올 수 없다.
 */
import { DEFAULT_SEVERITY, SEVERITIES } from "./severity.ts";

export interface SrDraft {
  serial: string;
  severity: string;
  subject: string;
  content: string;
}

/*
 * ## Prod Release 는 보관하지 않는다
 *
 * 릴리스는 **고른 제품에 딸린 값**인데, 제품은 이 초안에 담지 않는다(화면을 다시 열면
 * 목록 첫 제품으로 돌아간다). 릴리스만 되살리면 "제품은 A, 버전은 B 제품의 것" 이 되고,
 * 그 조합은 사람이 고른 적이 없다. 글을 지키는 것이 이 보관의 목적이고, 버전은 다시
 * 고르는 데 몇 초면 된다. 틀린 버전으로 올라가는 것보다 낫다.
 */

export const EMPTY_SR_DRAFT: SrDraft = {
  serial: "",
  severity: DEFAULT_SEVERITY,
  subject: "",
  content: "",
};

/** 보관할 알맹이가 있는가. 제목이나 본문 중 하나라도 있으면 그렇다. */
export function hasBody(draft: SrDraft): boolean {
  return draft.subject.trim() !== "" || draft.content.trim() !== "";
}

/**
 * 보관해 둔 초안을 읽는다. 읽을 수 없으면 null — **던지지 않는다.**
 *
 * 저장해 둔 값은 지난 배포의 모양일 수 있다(칸이 늘거나 줄거나, 등급 이름이 바뀌거나).
 * 모양이 어긋난 값을 그대로 화면 상태에 넣으면 작성 화면이 깨져 **아무 글도 못 쓰게**
 * 된다. 초안 보존은 편의지, 글쓰기를 막아도 되는 값이 아니다. 그래서 한 칸씩
 * 확인하고, 아니면 없는 것으로 둔다.
 */
export function parseSrDraft(text: string): SrDraft | null {
  if (text === "") return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const pick = (key: keyof SrDraft): string =>
      typeof raw[key] === "string" ? (raw[key] as string) : "";
    const restored: SrDraft = {
      serial: pick("serial"),
      // 아는 등급만 받는다. 모르는 값을 넣으면 선택칸이 빈 채로 떠 등록이 막힌다.
      severity: (SEVERITIES as readonly string[]).includes(pick("severity"))
        ? pick("severity")
        : DEFAULT_SEVERITY,
      subject: pick("subject"),
      content: pick("content"),
    };
    // 알맹이가 없으면 복구할 것이 없는 셈이다(저장 쪽과 같은 판정을 쓴다).
    return hasBody(restored) ? restored : null;
  } catch {
    return null;
  }
}
