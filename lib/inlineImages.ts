/**
 * 답변 본문에 박혀 온 이미지.
 *
 * Broadcom 은 화면 캡처를 **첨부가 아니라 본문 안에** 넣어 보낸다. 우리는 본문을
 * 텍스트로 바꿔 저장하므로(htmlToText) 그 이미지를 통째로 버리고 있었다. 파일이
 * 없어서 안 보인 것이 아니라 우리가 지우고 있었다 — 실측 238장.
 *
 * 주소는 포털 API 다.
 *
 *   https://api-broadcomcms-software.wolkenservicedesk.com/attachment/get_attachment_content?uniqueFileId=...
 *
 * supportftp 와 달리 **우리가 평소에 케이스를 읽는 그 호스트**라, 브라우저도 작업 큐도
 * 필요 없다. 세션 쿠키로 바로 받을 수 있다.
 *
 * ## 추적 픽셀을 걸러낸다
 *
 * 본문에는 메일 열람 추적용 1×1 이미지가 훨씬 많다(ktbizoffice, salesforce 등).
 * 그것까지 보여주면 답변마다 깨진 그림이 줄줄이 붙는다. **포털 API 주소만** 남긴다.
 * 이름을 몰라도 되고, 새 추적 업체가 생겨도 자동으로 걸러진다.
 *
 * 순수 함수다. 저장된 body_html 만 보면 되므로 스키마를 바꾸지 않는다.
 */

/** 포털 API 의 이미지 주소. 이 모양만 우리 이미지로 본다. */
const PORTAL_IMAGE =
  /<img[^>]+src\s*=\s*["']https:\/\/api-[^"']*wolkenservicedesk\.com\/attachment\/get_attachment_content\?uniqueFileId=([^"'&]+)/gi;

/**
 * uniqueFileId 로 쓸 수 있는 모양인가.
 *
 * 실측 두 가지다 — base64(`CpQzj686H/2m5FdP4ABYLw==`)와 숫자(`1553875694105`).
 * 주소를 만들 때 그대로 들어가므로, 이상한 값이 오면 여기서 끊는다.
 */
export function isFileId(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  // base64 때문에 `/` 와 `.` 를 허용해야 하는데, 그러면 `../etc/passwd` 같은 값도
  // 글자만으로는 통과한다. 실제로는 질의 문자열에만 들어가므로 경로로 해석되지
  // 않지만, 굳이 받을 이유가 없다.
  if (value.includes("..")) return false;
  return /^[A-Za-z0-9+/=_.-]+$/.test(value);
}

/**
 * 본문 HTML 에서 우리가 보여줄 이미지의 id 목록.
 *
 * 같은 이미지가 두 번 박혀 오는 경우가 있어(메일 인용) 중복을 없앤다.
 * 순서는 본문에 나온 순서를 지킨다 — 글과 그림의 짝이 어긋나면 읽기 어렵다.
 */
export function inlineImageIds(bodyHtml: string): string[] {
  if (bodyHtml === "") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of bodyHtml.matchAll(PORTAL_IMAGE)) {
    // HTML 안에서는 & 가 &amp; 로 적혀 있을 수 있다.
    const raw = decodeHtml(match[1] ?? "");
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      id = raw;
    }
    if (!isFileId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 주소 안에 섞여 오는 최소한의 HTML 실체 참조만 푼다. */
function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"');
}
