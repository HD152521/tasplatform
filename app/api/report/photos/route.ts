/**
 * 정기점검 보고서 사진 한 자리 — 넣기(POST) · 보기(GET) · 비우기(DELETE).
 *
 * 화면이 canvas 로 긴 변 1600px 로 줄여 보낸다. 그래도 **줄인 결과를 믿지 않는다** —
 * 도착한 바이트로 크기·형식·픽셀 수를 다시 본다(lib/reportPhotoLimits.ts).
 *
 * ## 왜 multipart 가 아니라 본문에 사진만 담나
 *
 * `request.formData()` 는 본문을 **통째로 메모리에 올린 뒤에야** 크기를 알려준다.
 * Content-Length 를 먼저 보는 것으로는 못 막는다 — 헤더가 아예 없으면(청크 전송)
 * 검사가 조용히 통과하고, 그 뒤엔 상한이 없다. 512MB 인스턴스에서 그런 요청 몇 개면
 * 웹이 죽고, 그러면 다른 사람의 보고서 작업까지 멈춘다.
 *
 * 그래서 사진을 본문에 그대로 싣고 이름·자리는 주소에 둔다. 본문은 스트림으로 읽으며
 * 상한을 넘는 순간 **더 받지 않고 끊는다**. multipart 파서가 사라지니 봉투 여유분을
 * 셀 일도 없어져 상한이 곧 사진 크기가 된다.
 *
 * 사진 내용은 어디에도 로그로 남기지 않는다. 고객 현장 사진이다.
 */
import { NextResponse } from "next/server";
import { isMonth } from "../../../../lib/instanceStore.ts";
import { cleanFileName } from "../../../../lib/attachmentUpload.ts";
import {
  MAX_PHOTO_BYTES,
  PHOTO_TOO_LARGE_MESSAGE,
  checkPhoto,
  isPhotoSlot,
} from "../../../../lib/reportPhotoLimits.ts";
import { deletePhoto, loadPhoto, savePhoto } from "../../../../lib/reportPhotos.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BAD_MONTH = "대상 월이 올바르지 않습니다 (YYYY-MM).";

/** month·slot 을 한 번에 검사한다. 세 메서드가 같은 검사를 쓴다. */
function readTarget(source: {
  month: unknown;
  slot: unknown;
}): { ok: true; month: string; slot: number } | { ok: false; message: string } {
  if (!isMonth(source.month)) return { ok: false, message: BAD_MONTH };
  if (!isPhotoSlot(source.slot)) {
    return { ok: false, message: "사진 자리가 올바르지 않습니다." };
  }
  return { ok: true, month: source.month, slot: Number(source.slot) };
}

type BodyRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: "empty" | "too_large" };

/**
 * 본문을 읽되 상한을 넘으면 **거기서 끊는다**.
 *
 * 다 받아 놓고 재지 않는 것이 요점이다. Content-Length 가 없거나 거짓이어도
 * 실제로 받은 바이트가 상한을 넘는 순간 읽기를 취소하므로, 메모리에 쌓이는 양이
 * 상한 + 마지막 조각으로 묶인다.
 */
async function readCappedBody(request: Request, limit: number): Promise<BodyRead> {
  const body = request.body;
  if (body === null) return { ok: false, code: "empty" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { ok: false, code: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return { ok: false, code: "empty" };
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** 저장해 둔 사진을 그대로 내려준다. 화면 미리보기가 `<img src>` 로 부른다. */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const target = readTarget({ month: params.get("month"), slot: params.get("slot") });
  if (!target.ok) {
    return NextResponse.json({ ok: false, message: target.message }, { status: 400 });
  }

  const photo = await loadPhoto(target.month, target.slot);
  if (photo === null) {
    return NextResponse.json({ ok: false, message: "사진이 없습니다." }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(Buffer.from(photo.data, "base64")), {
    status: 200,
    headers: {
      // mime 은 저장할 때 매직 바이트로 판정한 값이라 image/jpeg·image/png 뿐이다
      // (lib/reportPhotoLimits.ts 의 sniffPhotoMime). 올린 쪽이 Content-Type 을
      // 정하지 못한다는 뜻이고, 그래도 브라우저가 스스로 형식을 다시 추측하지
      // 않게 nosniff 를 붙인다.
      "Content-Type": photo.mime,
      "X-Content-Type-Options": "nosniff",
      // 사진이 바뀌면 저장 시각도 바뀌므로 화면이 주소에 그 값을 붙여 캐시를 깬다.
      // 그래서 여기서는 길게 들고 있게 둔다 — 넉 장을 매 렌더마다 다시 받을 이유가 없다.
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/**
 * 한 자리에 사진을 넣는다. 이미 있으면 갈아끼운다.
 *
 * 본문 = 사진 바이트. 주소 = month, slot, name(파일 이름, 표시용).
 */
export async function POST(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const target = readTarget({ month: params.get("month"), slot: params.get("slot") });
  if (!target.ok) {
    return NextResponse.json({ ok: false, message: target.message }, { status: 400 });
  }

  // 길이를 먼저 보는 것은 값싼 1차 관문일 뿐이다. 헤더가 없거나 거짓일 수 있어
  // 진짜 방어는 아래 readCappedBody 가 한다.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) {
    return NextResponse.json({ ok: false, message: PHOTO_TOO_LARGE_MESSAGE }, { status: 413 });
  }

  const read = await readCappedBody(request, MAX_PHOTO_BYTES);
  if (!read.ok) {
    return read.code === "too_large"
      ? NextResponse.json({ ok: false, message: PHOTO_TOO_LARGE_MESSAGE }, { status: 413 })
      : NextResponse.json({ ok: false, message: "넣을 사진이 없습니다." }, { status: 400 });
  }

  const check = checkPhoto({ slot: target.slot, bytes: read.bytes });
  if (!check.ok) {
    return NextResponse.json({ ok: false, message: check.message }, { status: 400 });
  }

  // 이름은 사람에게 어떤 사진인지 알려주는 용도뿐이지만, 경로 조각이 남으면 화면에
  // 엉뚱한 것이 찍힌다. 첨부와 같은 정리를 쓴다.
  const fileName = cleanFileName(params.get("name") ?? "");

  try {
    await savePhoto({
      month: target.month,
      slot: check.slot,
      fileName,
      mime: check.mime,
      data: Buffer.from(read.bytes).toString("base64"),
      bytes: check.bytes,
    });
  } catch (error) {
    // 저장 실패를 성공처럼 보이게 하지 않는다. 사진 내용은 메시지에 담기지 않는다.
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message: `저장 실패: ${message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    slot: check.slot,
    fileName,
    mime: check.mime,
    bytes: check.bytes,
    width: check.width,
    height: check.height,
  });
}

/** 한 자리를 비운다. */
export async function DELETE(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const target = readTarget({ month: params.get("month"), slot: params.get("slot") });
  if (!target.ok) {
    return NextResponse.json({ ok: false, message: target.message }, { status: 400 });
  }

  try {
    await deletePhoto(target.month, target.slot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message: `삭제 실패: ${message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, slot: target.slot });
}
