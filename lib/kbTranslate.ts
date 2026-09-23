/**
 * 기술 문서에서 번역하는 칸.
 *
 * 케이스 대화 번역과 같은 표(text_translations)를 쓴다. 칸마다 scope 를 따로 두어
 * 한 문서의 제목과 본문 네 칸이 각각 한 행이 된다 — 새 컬럼을 더하지 않아도 되고,
 * 번역이 없는 칸은 그냥 행이 없어 화면이 원문을 그대로 쓴다.
 *
 * 화면(클라이언트 컴포넌트)과 API 가 함께 쓰므로 server-only 를 붙이지 않는다.
 */
export interface KbTranslateField {
  /** kb_articles 의 컬럼 이름. */
  readonly column: string;
  /** text_translations.scope 값. */
  readonly scope: string;
}

export const KB_TRANSLATE_FIELDS: readonly KbTranslateField[] = [
  { column: "title", scope: "kb_title" },
  { column: "issue", scope: "kb_issue" },
  { column: "environment", scope: "kb_environment" },
  { column: "cause", scope: "kb_cause" },
  { column: "resolution", scope: "kb_resolution" },
];

/** 한 문서가 쓰는 모든 scope·ref 쌍. 한 번의 조회로 읽으려고 쓴다. */
export function kbTranslationRefs(
  articleIds: readonly number[],
): Array<{ scope: string; refId: number }> {
  const out: Array<{ scope: string; refId: number }> = [];
  for (const id of articleIds) {
    for (const field of KB_TRANSLATE_FIELDS) out.push({ scope: field.scope, refId: id });
  }
  return out;
}

/** 번역 묶음에서 한 문서의 한 칸을 꺼낸다. 없으면 원문. */
export function kbShown(
  translated: ReadonlyMap<string, string>,
  articleId: number,
  scope: string,
  original: string,
): string {
  return translated.get(`${scope}:${articleId}`) ?? original;
}
