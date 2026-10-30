/**
 * 요약(마크다운풍 텍스트) → Confluence storage(XHTML) 변환 — 순수 함수.
 *
 * 다루는 것:
 *   - ``` 로 감싼 코드 블록 → Confluence code 매크로
 *   - `###` 로 시작하는 섹션 헤딩 → `<h2>`, 그 아래 단계(`####`) → `<h3>`
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
 *
 * ## 코드 블록도 같은 구멍이었다
 *
 * 요약은 **진단 명령과 설정 구문을 코드 블록으로 그대로 옮기게** 되어 있다
 * (lib/summaryPrompt.ts 의 cleanSectionText 는 코드 블록 안을 일부러 건드리지 않는다).
 * 그런데 여기에는 그 규칙이 없어서, 게시된 문서에 ``` 와 명령이 **한 문단 안에 글자
 * 그대로** 찍혔다. 명령을 복사해 쓰려는 사람이 가장 많이 보는 자리인데 그랬다.
 *
 * Confluence storage 에는 `<pre>` 가 없다. 코드는 매크로로 넣어야 한다.
 */

/** 헤딩 줄인가. 이름은 따지지 않는다. */
function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line.trim());
}

/** 헤딩 줄에서 `#` 과 공백을 떼어낸다. */
function headingText(line: string): string {
  return line.trim().replace(/^#{1,6}\s*/, "");
}

/**
 * `#` 개수 → Confluence 헤딩 단계.
 *
 * 섹션 제목(`###`)은 전부터 `<h2>` 다. 그 아래 단계를 쓰게 되면서(`#### 조치 방안`)
 * 한 칸씩 내려 **안에 든 것으로 읽히게** 한다. 같은 `<h2>` 로 내보내면 조치 방안이
 * 문제·원인 분석과 같은 급의 장처럼 보여, 갈라 보이게 하려던 것이 거꾸로 된다.
 *
 * `#`·`##` 도 `<h2>` 로 둔다 — 조립하는 쪽이 쓰지 않는 모양이고, 본문이 문서 제목급
 * 헤딩을 갖는 것은 Confluence 에서 보기 흉하다.
 */
function headingTag(line: string): string {
  const depth = (line.trim().match(/^#{1,6}/) ?? [""])[0].length;
  return `h${Math.min(6, Math.max(2, depth - 1))}`;
}

/** 불릿 줄인가. `- ` 또는 `* ` 로 시작한다. */
function isBullet(line: string): boolean {
  return /^[-*]\s+\S/.test(line.trim());
}

/** 불릿 줄에서 기호를 떼어낸다. */
function bulletText(line: string): string {
  return line.trim().replace(/^[-*]\s+/, "");
}

/** 코드 블록을 여닫는 줄인가. ```bash 처럼 말이 붙어도 된다. */
function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

/**
 * 여는 줄에 붙은 말을 언어로 쓴다(```bash → bash).
 *
 * 아는 언어 목록을 두지 않는다 — 그 목록이 틀려서 헤딩이 깨진 것이 이 파일의 역사다.
 * 대신 **모양**만 본다. 매크로가 모르는 언어를 받으면 색칠만 안 되고 블록은 그대로
 * 나오므로, 틀려도 손실이 없다. 모양이 아니면 아예 붙이지 않는다.
 */
function fenceLanguage(line: string): string {
  const word = line.trim().replace(/^```/, "").trim().toLowerCase();
  return /^[a-z0-9#+_-]{1,20}$/.test(word) ? word : "";
}

/**
 * 코드 블록 하나를 매크로로 만든다.
 *
 * 본문은 CDATA 로 감싸므로 이스케이프하지 않는다 — 그래야 `<`·`&` 가 들어간 설정
 * 구문이 원문대로 보인다. 대신 **CDATA 를 닫는 글자(`]]>`)만** 쪼개 준다. 그게
 * 본문에 있으면 문서가 그 자리에서 깨져 게시 자체가 실패한다.
 */
function renderCode(lines: string[], language: string): string {
  const body = lines.join("\n").replace(/\]\]>/g, "]]]]><![CDATA[>");
  const param = language === ""
    ? ""
    : `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>`;
  // ac:schema-version 은 Confluence 가 직접 뽑아내는 storage 에 늘 붙어 있다. 없이도
  // 받아 주는 편이지만, 매크로를 거부하거나 다르게 그리는 판본이 있어 맞춰 둔다.
  return '<ac:structured-macro ac:name="code" ac:schema-version="1">' + param
    + `<ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body>`
    + "</ac:structured-macro>";
}

/**
 * 한 줄 안의 `백틱` 을 코드 글씨로 바꾼다.
 *
 * **이스케이프한 뒤에** 부른다. 그래야 `<` 가 들어간 조각도 안전하고, 백틱은
 * 이스케이프 대상이 아니라 그대로 남아 있다.
 */
function inlineCode(escaped: string): string {
  return escaped.replace(/`([^`\n]+)`/g, "<code>$1</code>");
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
    const tds = cells.map((c) => `<${tag}>${inlineCode(escapeXml(c))}</${tag}>`).join("");
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
    out.push(`<p>${para.map((l) => inlineCode(escapeXml(l))).join("<br/>")}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    /*
     * 코드 블록이 **먼저**다. 안에 있는 `#`·`-`·`|` 는 헤딩도 불릿도 표도 아니다 —
     * 주석이나 옵션일 뿐이다. 뒤로 미루면 명령이 제목으로 바뀐다.
     */
    if (isFence(line)) {
      flushPara();
      const language = fenceLanguage(line);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      // 닫는 줄이 없으면(모델이 빠뜨리면) 글 끝까지가 코드다. 여는 줄만 글자로
      // 남기는 것보다 낫다 — 그게 지금 게시된 문서의 모습이었다.
      out.push(renderCode(body, language));
      continue;
    }

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
      out.push(`<ul>${items.map((t) => `<li>${inlineCode(escapeXml(t))}</li>`).join("")}</ul>`);
      continue;
    }

    // `#` 으로 시작하면 **이름을 따지지 않고** 헤딩이다(위 주석 참고).
    if (isHeading(line)) {
      flushPara();
      const tag = headingTag(line);
      out.push(`<${tag}>${escapeXml(headingText(line))}</${tag}>`);
      continue;
    }

    para.push(trimmed);
  }
  flushPara();
  return out.join("\n");
}
