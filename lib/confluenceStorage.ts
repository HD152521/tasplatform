/**
 * 요약(마크다운풍 텍스트) → Confluence storage(XHTML) 변환 — 순수 함수.
 *
 * assembleConfluenceDoc 가 만드는 형태를 다룬다:
 *   - 섹션 헤딩(빈 줄로 구분된 한 줄): "문제 정의" 등
 *   - 마크다운 파이프 표: | 구분 | 내용 |  \n  |---|---|  \n  | a | b |
 *   - 나머지 줄: 문단
 * Confluence v2 pages API 는 representation="storage"(XHTML)만 받으므로 여기서 변환한다.
 * 완벽한 마크다운 파서가 아니라, 이 요약 형식만 안전히 다루는 최소 변환기다.
 */

/** 섹션 헤딩으로 인식할 줄(assembleConfluenceDoc 의 heading 들). */
const HEADINGS: ReadonlySet<string> = new Set([
  "문제 정의",
  "원인 및 기술 배경",
  "해결 방법",
  "최종 결과",
]);

/** XML 특수문자를 이스케이프한다(storage 는 XHTML 이라 필수). */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

/** "| a | b |" → ["a","b"] (양 끝 파이프 제거, 각 셀 trim). */
function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** 구분선 행(|---|---|)인가. */
function isSeparatorRow(line: string): boolean {
  return splitRow(line).every((c) => /^:?-{2,}:?$/.test(c) || c === "");
}

function renderTable(rows: string[]): string {
  const parsed = rows.map(splitRow);
  const hasSep = rows.length >= 2 && isSeparatorRow(rows[1] ?? "");
  const out: string[] = ["<table><tbody>"];
  parsed.forEach((cells, idx) => {
    if (hasSep && idx === 1) return; // 구분선 건너뜀
    const tag = hasSep && idx === 0 ? "th" : "td";
    const tds = cells.map((c) => `<${tag}>${escapeXml(c)}</${tag}>`).join("");
    out.push(`<tr>${tds}</tr>`);
  });
  out.push("</tbody></table>");
  return out.join("");
}

/** 마크다운풍 요약 텍스트를 Confluence storage XHTML 로 바꾼다. */
export function toConfluenceStorage(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length === 0) return;
    out.push(`<p>${para.map(escapeXml).join("<br/>")}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (isTableRow(line)) {
      flushPara();
      const rows: string[] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        rows.push(lines[i] ?? "");
        i += 1;
      }
      i -= 1;
      out.push(renderTable(rows));
      continue;
    }

    if (trimmed === "") {
      flushPara();
      continue;
    }

    const headingText = trimmed.replace(/^#{1,6}\s*/, "");
    if (HEADINGS.has(headingText)) {
      flushPara();
      out.push(`<h2>${escapeXml(headingText)}</h2>`);
      continue;
    }

    para.push(trimmed);
  }
  flushPara();
  return out.join("\n");
}
