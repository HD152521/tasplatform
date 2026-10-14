/**
 * 요약(마크다운풍 텍스트) → Confluence storage(XHTML) 변환 — 순수 함수.
 *
 * 다루는 것:
 *   - `###` 로 시작하는 섹션 헤딩 → `<h2>`
 *   - `- ` / `* ` 로 시작하는 줄 → `<ul><li>`
 *   - 마크다운 파이프 표 → `<table>`
 *   - 나머지 줄: 문단
 * Confluence v2 pages API 는 representation="storage"(XHTML)만 받으므로 여기서 변환한다.
 * 완벽한 마크다운 파서가 아니라, 이 요약 형식만 안전히 다루는 최소 변환기다.
 */

/**
 * ## 왜 섹션 이름 목록을 쓰지 않나
 *
 * 전에는 **아는 섹션 이름 네 개**(문제 정의 / 원인 및 기술 배경 / 해결 방법 /
 * 최종 결과)만 헤딩으로 인식했다. 그 사이 요약 프롬프트의 섹션 이름이 바뀌어
 * (문제 / 환경 및 진단 내역 / 원인 분석 / 해결 제안 및 조치 방안) **네 개가 하나도
 * 안 맞게 됐고**, 게시된 문서에 `### 문제` 가 글자 그대로 찍혔다.
 *
 * 이름으로 판별하면 프롬프트가 바뀔 때마다 **조용히** 깨진다. 그래서 `###` 라는
 * 모양으로 판별한다 — 섹션 이름이 무엇이든 따라온다.
 *
 * 불릿(`- `)도 처리하지 않고 있었다. 목록이 아니라 한 문단에 `<br/>` 로 이어 붙어
 * 나갔다. 그것도 같이 고쳤다.
 */

/** 헤딩 줄인가. 이름은 따지지 않는다. */
function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line.trim());
}

/** 헤딩 줄에서 `#` 과 공백을 떼어낸다. */
function headingText(line: string): string {
  return line.trim().replace(/^#{1,6}\s*/, "");
}

/** 불릿 줄인가. `- ` 또는 `* ` 로 시작한다. */
function isBullet(line: string): boolean {
  return /^[-*]\s+\S/.test(line.trim());
}

/** 불릿 줄에서 기호를 떼어낸다. */
function bulletText(line: string): string {
  return line.trim().replace(/^[-*]\s+/, "");
}

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

    // 불릿이 이어지는 동안 **한 목록으로 묶는다.** 한 줄씩 문단으로 내면 Confluence
    // 에서 목록이 아니라 그냥 줄바꿈으로 보인다.
    if (isBullet(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && isBullet(lines[i] ?? "")) {
        items.push(bulletText(lines[i] ?? ""));
        i += 1;
      }
      i -= 1;
      out.push(`<ul>${items.map((t) => `<li>${escapeXml(t)}</li>`).join("")}</ul>`);
      continue;
    }

    // `#` 으로 시작하면 **이름을 따지지 않고** 헤딩이다(위 주석 참고).
    if (isHeading(line)) {
      flushPara();
      out.push(`<h2>${escapeXml(headingText(line))}</h2>`);
      continue;
    }

    para.push(trimmed);
  }
  flushPara();
  return out.join("\n");
}
