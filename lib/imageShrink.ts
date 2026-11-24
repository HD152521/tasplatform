/**
 * 브라우저에서 이미지를 줄인다.
 *
 * ## 왜 브라우저에서 줄이나
 *
 * 4K 화면 캡처 PNG 는 8~15MB 다. 그게 첨부 경로를 지나려면 base64 로 33% 불어나 DB
 * 행이 되고(attachment_jobs.payload) 수집기까지 간다. 보내기 전에 줄이면 그 전부가
 * 가벼워지고, 사람도 기다리지 않는다.
 *
 * ## 줄이는 것을 기본으로 삼지 않는다
 *
 * 이 도구의 첨부는 **고객 케이스의 증거**다. 오류 메시지가 적힌 화면 캡처를 1600px
 * JPEG 로 바꾸면 글자가 뭉개져 읽을 수 없게 되는 일이 실제로 있다. 그래서 이 함수를
 * 부르는 쪽은 **원본과 줄인 것을 함께 보여 주고 사람이 고르게** 한다
 * (app/cases/[id]/AttachButton.tsx). 조용히 줄여 올리면 증거가 바뀐 것이고, 바뀐 줄
 * 아무도 모른다.
 *
 * 보고서 사진(app/report/PhotoStep.tsx)은 다르다 — 거기서는 슬라이드에 넣을 사진이라
 * 줄이는 것이 맞고, 그래서 그 화면은 늘 줄인다.
 *
 * ## 브라우저 전용이다
 *
 * document·Image·canvas 를 쓴다. **서버에서 부르면 터진다.** 이 레포의 lib 에 두는
 * 이유는 화면 두 곳이 같은 함수를 써야 해서다(갈라지면 한쪽만 고쳐진다).
 */
import { PHOTO_JPEG_QUALITY, PHOTO_LONG_EDGE } from "./reportPhotoLimits.ts";

/** 우리가 줄일 수 있는 이미지인가. 브라우저가 canvas 로 그릴 수 있는 것만 본다. */
export function isShrinkableImage(type: string): boolean {
  const mime = type.trim().toLowerCase();
  // HEIC·TIFF 는 브라우저가 못 그린다. 거기까지 받으면 "읽을 수 없습니다" 로 끝난다.
  return mime === "image/jpeg" || mime === "image/png" || mime === "image/webp";
}

/** 확장자를 .jpg 로 바꾼다. 줄인 결과는 늘 JPEG 다. */
export function asJpegName(raw: string): string {
  const base = raw.replace(/\.[^.]+$/, "");
  return `${base === "" ? "image" : base}.jpg`;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    // 브라우저가 못 읽는 형식(HEIC 등)은 여기로 온다. 사람에게 이유를 말해 준다.
    img.onerror = () => reject(new Error("이미지를 읽을 수 없습니다. JPEG 또는 PNG 로 저장해 주세요."));
    img.src = url;
  });
}

/** canvas → JPEG File. 변환 실패를 조용히 넘기지 않는다. */
async function toJpegFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY);
  });
  if (blob === null) throw new Error("이미지를 변환하지 못했습니다.");
  return new File([blob], name, { type: "image/jpeg" });
}

/**
 * 긴 변을 `longEdge` 로 줄여 JPEG 로 다시 만든다.
 *
 * 원본이 이미 작으면 키우지 않는다(scale 상한 1) — 없는 화소를 만들어 봐야 용량만 는다.
 */
export async function shrinkImage(
  file: File,
  options: { readonly longEdge?: number } = {},
): Promise<File> {
  const longEdge = options.longEdge ?? PHOTO_LONG_EDGE;
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (longest === 0) throw new Error("이미지 크기를 알 수 없습니다.");
    const scale = Math.min(1, longEdge / longest);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("이 브라우저에서는 이미지를 줄일 수 없습니다.");
    ctx.drawImage(img, 0, 0, width, height);

    return await toJpegFile(canvas, asJpegName(file.name));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 이미지를 시계방향 90도 돌린 새 파일을 만든다.
 *
 * 돌려서 **저장까지** 한다. 넣을 때 각도만 주는 방법도 있지만, 그러면 그림이 제 자리에서
 * 회전할 뿐 차지하는 칸은 그대로라 가로로 긴 사진이 상자 밖으로 삐져나간다. 파일 자체를
 * 돌려 두면 그 뒤로는 평범한 세로 사진과 똑같이 다뤄진다.
 *
 * 줄이기를 이미 거친 파일에 쓰므로 다시 줄이지 않는다 — 긴 변은 그대로고 가로세로만 바뀐다.
 */
export async function rotateImage90(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (width === 0 || height === 0) throw new Error("이미지 크기를 알 수 없습니다.");

    // 돌리면 가로세로가 바뀐다.
    const canvas = document.createElement("canvas");
    canvas.width = height;
    canvas.height = width;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("이 브라우저에서는 이미지를 돌릴 수 없습니다.");
    // 새 캔버스의 오른쪽 위를 원점으로 삼아 90도 돌린 뒤 그린다.
    ctx.translate(height, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, 0, 0);

    return await toJpegFile(canvas, file.name);
  } finally {
    URL.revokeObjectURL(url);
  }
}
