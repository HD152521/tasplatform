/**
 * 올릴 파일을 받아도 되는지 판정한다 — 웹 입구에서 한 번.
 *
 * ## 왜 라우트 안이 아니라 여기인가
 *
 * 이 판정이 틀리면 **조용히 망가진다**. 파일은 큐를 거쳐 수집기로 넘어가고, 거기서
 * 브라우저가 열리고, 그다음에 실패한다 — 사람은 수십 초 뒤에 이유 없는 실패만 본다.
 * 그래서 판정만 떼어 단위테스트로 잠갔다. 라우트는 formData 를 여기 넘기기만 한다.
 *
 * ## 왜 의존성이 하나도 없는가
 *
 * 같은 상한을 **버튼(클라이언트 컴포넌트)에서도** 써야 한다. 8MB 를 다 올려보낸 뒤
 * 거절당하는 것은 회선만 낭비하는 짓이고, 사람은 그동안 기다린다. 여기서 node:crypto
 * 같은 것을 하나라도 물면 클라이언트 번들이 깨지므로, 이 파일은 순수하게 둔다.
 *
 * ## 상한을 50MB 로 잡은 근거
 *
 * 파일은 attachment_jobs.payload 에 **base64 로** 들어간다(lib/attachmentJobs.ts).
 * 33% 가 붙어 DB 행이 되고, SQLite·Postgres 를 가리지 않으려고 고른 방식이다.
 *
 * 처음에는 8MB 였다. 그런데 **그러면 이 도구를 쓰는 뜻이 없어진다** — 포털에 안 들어가려고
 * 만든 것인데 첨부할 때마다 들어가야 했다. 50MB 로 올린 근거는 둘이다.
 *
 *   - **쓰는 사람이 사내 VPN 안의 소수다.** 동시에 큰 파일을 올릴 일이 사실상 없어서,
 *     동시성으로 메모리가 터지는 그림을 걱정하지 않아도 된다.
 *   - 대신 **한 건의 피크**는 실재한다. 업로드 라우트가 본문을 메모리에 올리고(50MB),
 *     base64 로 바꾸고(67MB), DB 드라이버가 또 한 벌 직렬화한다(67MB). 그래서 웹 앱
 *     메모리를 512M → 1G 로 올렸다(manifest.yml 의 broadcom-sr-web). 512M 에서는
 *     한 건만으로도 OOM 가능성이 있었다.
 *
 * DB 보관량은 lib/attachmentJobs.ts 의 UPLOAD_KEEP_MS 주석에 다시 계산해 두었다.
 * 상한을 넘으면 포털에서 직접 올리게 안내한다 — 막는 것이 아니라 더 맞는 길로 보낸다.
 */

/**
 * 이 경로로 올릴 수 있는 최대 크기.
 *
 * 올리면 웹 앱 메모리(manifest.yml)와 DB 보관량이 함께 움직인다. 숫자만 바꾸지 말고
 * 위 주석의 계산을 다시 할 것.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** 상한을 사람에게 보여줄 때 쓰는 표기. 숫자와 문구가 따로 놀지 않게 여기서 만든다. */
export const MAX_UPLOAD_LABEL = `${MAX_UPLOAD_BYTES / (1024 * 1024)}MB`;

/** 상한을 넘었을 때의 안내. 라우트와 버튼이 같은 문장을 쓴다. */
export const TOO_LARGE_MESSAGE =
  `${MAX_UPLOAD_LABEL} 보다 큰 파일은 이 경로로 올릴 수 없습니다. 포털에서 직접 올려주세요.`;

export type UploadRequestCheck =
  | { ok: true; requestId: number; fileName: string }
  | { ok: false; code: "invalid" | "too_large"; message: string };

/**
 * 파일 이름에서 경로를 걷어낸다.
 *
 * 이 이름은 큐에 저장되고 결국 CrushFTP 의 올릴 경로에 들어간다. `..` 이나 구분자가
 * 남으면 남의 폴더를 가리킬 수 있다. 마지막 방어선은 lib/crushftp.ts 의 safeFileName
 * 이고(그쪽이 실제로 경로를 만든다), 여기서 한 번 더 하는 이유는 **사람이 이유를 즉시
 * 듣게** 하려는 것이다. 두 곳이 갈라지면 조용히 어긋나므로 계약 테스트로 묶어 뒀다.
 * 빈 문자열은 "쓸 이름이 없다" 는 뜻이고, 호출부가 거절한다.
 */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim();
  if (cleaned === "." || cleaned === "..") return "";
  return cleaned;
}

/**
 * 올릴 요청 한 건을 판정한다.
 *
 * 크기 0 을 거절하는 이유: 수집기까지 가서야 "올릴 내용이 비어 있습니다" 로 끝난다
 * (collector/attachments.ts). 사람 앞에서 즉시 말해 주는 편이 낫다.
 */
export function checkUploadRequest(input: {
  requestId: unknown;
  fileName: unknown;
  size: unknown;
}): UploadRequestCheck {
  const requestId = Number(input.requestId);
  if (!Number.isSafeInteger(requestId) || requestId <= 0) {
    return { ok: false, code: "invalid", message: "케이스 번호가 올바르지 않습니다." };
  }

  const fileName = typeof input.fileName === "string" ? cleanFileName(input.fileName) : "";
  if (fileName === "") {
    return { ok: false, code: "invalid", message: "파일 이름을 알 수 없습니다." };
  }

  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, code: "invalid", message: "빈 파일은 올릴 수 없습니다." };
  }
  if (size > MAX_UPLOAD_BYTES) {
    return { ok: false, code: "too_large", message: TOO_LARGE_MESSAGE };
  }

  return { ok: true, requestId, fileName };
}
