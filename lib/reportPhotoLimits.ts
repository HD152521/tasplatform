/**
 * 정기점검 보고서에 넣을 사진의 상한과 판정 — 화면과 서버가 같은 값을 쓴다.
 *
 * ## 왜 의존성이 하나도 없는가
 *
 * 같은 상한을 **사진 고르는 화면(클라이언트 컴포넌트)에서도** 써야 한다. 4MB 를 다
 * 올려보낸 뒤 거절당하는 것은 회선만 낭비하는 짓이고, 사람은 그동안 기다린다.
 * 여기서 node: 모듈을 하나라도 물면 클라이언트 번들이 깨지므로 순수하게 둔다
 * (lib/attachmentUpload.ts 와 같은 이유·같은 모양).
 *
 * ## 왜 상한이 4MB 이고 왜 줄여서 저장하나
 *
 * 사진은 report_photos.data 에 **base64 로** 들어간다. 33% 가 붙어 DB 행이 되고,
 * SQLite·Postgres 를 가르지 않으려고 고른 방식이다(attachment_jobs.payload 와 같다).
 * 게다가 슬라이드에서 차지하는 자리가 3.9×5.5인치뿐이다 — 인쇄 기준 300dpi 로 쳐도
 * 긴 변 1650px 이면 충분하다. 원본을 그대로 들고 있을 이유가 없어서 **긴 변 1600px**
 * 로 줄여 저장한다.
 *
 * 줄이는 일은 화면에서 canvas 로 한다. 서버에서 줄이려면 이미지 라이브러리를 새로
 * 들여야 하는데(sharp 는 네이티브 빌드라 TAS 노드 빌드팩에서 문제가 된다) 브라우저는
 * 이미 디코더를 갖고 있다. 대신 **화면이 줄인 결과를 믿지는 않는다** — 서버는 도착한
 * 바이트로 상한과 형식을 다시 본다.
 */

/** 사진 자리 수. 슬라이드 2장 × 장당 2장. */
export const PHOTO_SLOT_COUNT = 4;

/**
 * 사진 한 장의 정보 — 사진 바이트는 빼고.
 *
 * 저장(lib/reportPhotos.ts)이 아니라 여기 두는 이유: 화면이 이 모양을 그대로 받는다.
 * server-only 가 붙은 모듈에서 타입만 끌어오면 번들러 설정 하나가 바뀌는 순간
 * 클라이언트 번들이 깨진다. 값이 없는 순수 모듈에 두면 그럴 일이 없다.
 */
export interface ReportPhotoMeta {
  readonly slot: number;
  readonly fileName: string;
  readonly mime: string;
  readonly bytes: number;
  readonly savedAt: string;
}

/** 장당 최대 크기. base64 로 부풀어 DB 행이 되므로 작게 잡는다. */
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

/** 상한을 사람에게 보여줄 때 쓰는 표기. 숫자와 문구가 따로 놀지 않게 여기서 만든다. */
export const MAX_PHOTO_LABEL = `${MAX_PHOTO_BYTES / (1024 * 1024)}MB`;

/** 상한을 넘었을 때의 안내. 라우트와 화면이 같은 문장을 쓴다. */
export const PHOTO_TOO_LARGE_MESSAGE =
  `${MAX_PHOTO_LABEL} 보다 큰 사진은 넣을 수 없습니다. 더 작게 저장해 다시 올려주세요.`;

/** 저장할 때 줄일 긴 변 길이(px). */
export const PHOTO_LONG_EDGE = 1600;

/** 줄일 때 쓰는 JPEG 품질. 현장 사진·스크린샷에서 눈에 띄는 열화 없이 용량이 확 준다. */
export const PHOTO_JPEG_QUALITY = 0.85;

/**
 * 받아들이는 형식.
 *
 * python-pptx 가 add_picture 로 확실히 받는 것만 둔다. WebP·HEIC 는 헤더를 못 읽어
 * **보고서 생성 단계에서** 터진다 — 사진을 넣던 사람은 이미 그 화면을 떠났고, 실패는
 * 며칠 뒤 다른 사람 앞에서 난다. 그래서 입구에서 거른다.
 */
export const PHOTO_MIMES = ["image/jpeg", "image/png"] as const;
export type PhotoMime = (typeof PHOTO_MIMES)[number];

/** 파일 고르기 창에 걸 accept 값. */
export const PHOTO_ACCEPT = PHOTO_MIMES.join(",");

/**
 * base64 문자열이 담고 있는 실제 바이트 수.
 *
 * 디코드하지 않고 센다 — 크기를 재려고 4MB 를 메모리에 펼칠 이유가 없다.
 */
export function base64Bytes(base64: string): number {
  const body = base64.replace(/=+$/, "");
  return Math.floor((body.length * 3) / 4);
}

/**
 * base64 앞머리로 형식을 알아낸다. 확장자나 Content-Type 을 믿지 않는다.
 *
 * 바이트로 풀지 않고 문자열 앞부분만 본다 — base64 는 3바이트가 4글자로 고정 대응하므로
 * 앞 몇 글자가 곧 앞 몇 바이트다. JPEG 의 FF D8 FF 가 "/9j/", PNG 의 89 50 4E 47…이
 * "iVBORw0KGgo" 다. 이 파일은 클라이언트에서도 쓰이므로 Buffer 를 쓸 수 없다.
 */
export function sniffPhotoMime(base64: string): PhotoMime | null {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  return null;
}

/** 사진 자리 번호는 1..PHOTO_SLOT_COUNT 다. 그 밖에는 놓을 자리가 없다. */
export function isPhotoSlot(value: unknown): value is number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= PHOTO_SLOT_COUNT;
}

export type PhotoCheck =
  | { ok: true; slot: number; mime: PhotoMime; bytes: number }
  | { ok: false; code: "invalid" | "too_large" | "unsupported"; message: string };

/**
 * 사진 한 장을 받아도 되는지 판정한다.
 *
 * 크기 0 을 거절하는 이유: 빈 사진은 보고서 생성 단계(python add_picture)에서야 터진다.
 * 사람 앞에서 즉시 말해 주는 편이 낫다.
 */
export function checkPhoto(input: { slot: unknown; base64: unknown }): PhotoCheck {
  if (!isPhotoSlot(input.slot)) {
    return { ok: false, code: "invalid", message: "사진 자리가 올바르지 않습니다." };
  }
  const slot = Number(input.slot);

  if (typeof input.base64 !== "string" || input.base64 === "") {
    return { ok: false, code: "invalid", message: "빈 사진은 넣을 수 없습니다." };
  }
  const bytes = base64Bytes(input.base64);
  if (bytes <= 0) {
    return { ok: false, code: "invalid", message: "빈 사진은 넣을 수 없습니다." };
  }
  if (bytes > MAX_PHOTO_BYTES) {
    return { ok: false, code: "too_large", message: PHOTO_TOO_LARGE_MESSAGE };
  }

  const mime = sniffPhotoMime(input.base64);
  if (mime === null) {
    return {
      ok: false,
      code: "unsupported",
      message: "JPEG 또는 PNG 사진만 넣을 수 있습니다.",
    };
  }

  return { ok: true, slot, mime, bytes };
}
