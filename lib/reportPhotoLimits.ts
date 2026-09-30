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

/**
 * **저장하는** 사진 한 장의 최대 크기. base64 로 부풀어 DB 행이 되므로 작게 잡는다.
 *
 * 이 상한은 **줄인 뒤**의 크기에 건다. 고른 원본에 걸면 안 된다 — 요즘 휴대폰 사진은
 * 한 장이 3~15MB 라, 원본으로 재면 현장에서 찍은 사진은 거의 다 거부당한다. 정작
 * 긴 변 1600px 로 줄이면 몇백 KB 가 된다(실측: 2400×3200 → 34KB). 줄이려고 만든
 * 기능이 줄이기도 전에 막아서는 안 된다.
 */
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

/** 상한을 사람에게 보여줄 때 쓰는 표기. 숫자와 문구가 따로 놀지 않게 여기서 만든다. */
export const MAX_PHOTO_LABEL = `${MAX_PHOTO_BYTES / (1024 * 1024)}MB`;

/** 상한을 넘었을 때의 안내. 라우트와 화면이 같은 문장을 쓴다. */
export const PHOTO_TOO_LARGE_MESSAGE =
  `${MAX_PHOTO_LABEL} 보다 큰 사진은 넣을 수 없습니다. 더 작게 저장해 다시 올려주세요.`;

/**
 * **고를 수 있는** 원본의 최대 크기.
 *
 * 저장 상한보다 훨씬 크다. 원본은 줄여서 보낼 것이므로 크기 자체는 문제가 아니고,
 * 이 값은 "브라우저가 이걸 펼치다 탭이 죽는다" 를 막는 선일 뿐이다. 1억 화소 휴대폰
 * 사진도 20MB 안쪽이라 40MB 면 현장에서 찍은 사진은 전부 들어온다.
 */
export const MAX_ORIGINAL_BYTES = 40 * 1024 * 1024;

export const ORIGINAL_TOO_LARGE_MESSAGE =
  `${MAX_ORIGINAL_BYTES / (1024 * 1024)}MB 보다 큰 파일은 열 수 없습니다.`
  + " 사진이 아니라 다른 파일을 고르지 않았는지 확인해 주세요.";

/** 저장할 때 줄일 긴 변 길이(px). */
export const PHOTO_LONG_EDGE = 1600;

/**
 * 받아들이는 긴 변의 상한(px).
 *
 * 화면은 PHOTO_LONG_EDGE 로 줄여 보내므로 평소에는 근처도 못 간다. 이 값은 **라우트를
 * 직접 부르는 경우**를 막는 방어선이다. 4MB 안에 드는 작은 파일이라도 픽셀 수는 얼마든지
 * 키울 수 있다(압축 폭탄). 그런 사진은 보고서에 박혀 나가서, 파일을 여는 고객의
 * PowerPoint 가 그 픽셀을 전부 펼친다. 3.9×5.5인치 자리에 들어가므로 300dpi 로 쳐도
 * 1650px 이면 충분하고, 여유를 두어 4000px 로 막는다.
 */
export const MAX_PHOTO_EDGE = 4000;

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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 두 바이트를 빅엔디안 정수로. 이미지 헤더의 길이·크기는 전부 이 꼴이다. */
function be16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

/**
 * 앞머리 바이트로 형식을 알아낸다. 확장자나 Content-Type 을 믿지 않는다.
 *
 * Buffer 가 아니라 Uint8Array 를 받는다 — 이 파일은 클라이언트에서도 쓰인다.
 */
export function sniffPhotoMime(bytes: Uint8Array): PhotoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return "image/png";
  }
  return null;
}

/** PNG 의 가로·세로. IHDR 이 반드시 첫 청크라 자리가 고정이다(16~23바이트). */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // 8(서명) + 4(길이) + 4("IHDR") = 16 부터 가로 4바이트, 세로 4바이트.
  if (bytes.length < 24) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const width = (be16(bytes, 16) << 16) | be16(bytes, 18);
  const height = (be16(bytes, 20) << 16) | be16(bytes, 22);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** SOF(Start Of Frame) 마커. 여기에 가로·세로가 들어 있다. */
function isJpegFrameMarker(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  // C4(허프만 표)·C8(JPG 확장)·CC(산술 부호 표)는 프레임이 아니다.
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * JPEG 의 가로·세로.
 *
 * PNG 와 달리 자리가 고정이 아니라 마커를 하나씩 건너뛰며 SOF 를 찾아야 한다.
 * 전부 헤더만 읽는다 — 픽셀을 펼치지 않으므로 큰 사진이어도 비용이 일정하다.
 */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 2; // SOI(FF D8) 다음부터
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null; // 마커가 아니면 우리가 읽을 수 있는 파일이 아니다
    let marker = bytes[at + 1] ?? 0;
    // FF 가 채움(padding)으로 여러 개 붙기도 한다.
    while (marker === 0xff && at + 2 < bytes.length) {
      at += 1;
      marker = bytes[at + 1] ?? 0;
    }
    if (isJpegFrameMarker(marker)) {
      // 세그먼트: [길이 2][정밀도 1][세로 2][가로 2]
      const height = be16(bytes, at + 5);
      const width = be16(bytes, at + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01
      || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // 길이가 없는 마커
      continue;
    }
    const length = be16(bytes, at + 2);
    if (length < 2) return null; // 길이가 이상하면 더 못 읽는다
    at += 2 + length;
  }
  return null;
}

/**
 * 사진의 픽셀 크기. 읽지 못하면 null.
 *
 * 헤더만 본다 — 픽셀을 펼치면 압축 폭탄에 그대로 당한다(MAX_PHOTO_EDGE 주석).
 */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const mime = sniffPhotoMime(bytes);
  if (mime === "image/png") return pngSize(bytes);
  if (mime === "image/jpeg") return jpegSize(bytes);
  return null;
}

/** 사진 자리 번호는 1..PHOTO_SLOT_COUNT 다. 그 밖에는 놓을 자리가 없다. */
export function isPhotoSlot(value: unknown): value is number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= PHOTO_SLOT_COUNT;
}

export type PhotoCheck =
  | { ok: true; slot: number; mime: PhotoMime; bytes: number; width: number; height: number }
  | {
    ok: false;
    code: "invalid" | "too_large" | "unsupported" | "too_many_pixels";
    message: string;
  };

/**
 * 사진 한 장을 받아도 되는지 판정한다. 실제 바이트로 본다.
 *
 * 크기 0 을 거절하는 이유: 빈 사진은 보고서 생성 단계(python add_picture)에서야 터진다.
 * 사람 앞에서 즉시 말해 주는 편이 낫다.
 *
 * 픽셀 크기까지 보는 이유는 MAX_PHOTO_EDGE 주석에 적었다 — 바이트 상한만으로는
 * 압축 폭탄을 막지 못한다.
 */
export function checkPhoto(input: { slot: unknown; bytes: Uint8Array }): PhotoCheck {
  if (!isPhotoSlot(input.slot)) {
    return { ok: false, code: "invalid", message: "사진 자리가 올바르지 않습니다." };
  }
  const slot = Number(input.slot);

  const bytes = input.bytes;
  if (bytes.length === 0) {
    return { ok: false, code: "invalid", message: "빈 사진은 넣을 수 없습니다." };
  }
  if (bytes.length > MAX_PHOTO_BYTES) {
    return { ok: false, code: "too_large", message: PHOTO_TOO_LARGE_MESSAGE };
  }

  const mime = sniffPhotoMime(bytes);
  if (mime === null) {
    return {
      ok: false,
      code: "unsupported",
      message: "JPEG 또는 PNG 사진만 넣을 수 있습니다.",
    };
  }

  const size = readImageSize(bytes);
  if (size === null) {
    // 앞머리는 JPEG·PNG 인데 크기를 못 읽었다 = 헤더가 깨졌거나 우리가 모르는 변형이다.
    // 통과시키면 보고서를 만드는 단계에서 터진다.
    return {
      ok: false,
      code: "unsupported",
      message: "사진의 크기를 읽을 수 없습니다. 다시 저장해 올려주세요.",
    };
  }
  if (Math.max(size.width, size.height) > MAX_PHOTO_EDGE) {
    return {
      ok: false,
      code: "too_many_pixels",
      message: `긴 변이 ${MAX_PHOTO_EDGE}px 보다 큰 사진은 넣을 수 없습니다.`,
    };
  }

  return { ok: true, slot, mime, bytes: bytes.length, width: size.width, height: size.height };
}
