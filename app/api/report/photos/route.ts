/**
 * 정기점검 보고서 사진 한 자리 — 넣기(POST) · 보기(GET) · 비우기(DELETE).
 *
 * 화면이 canvas 로 긴 변 1600px 로 줄여 보낸다. 그래도 **줄인 결과를 믿지 않는다** —
 * 도착한 바이트로 상한과 형식을 다시 본다(lib/reportPhotoLimits.ts).
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

/** multipart 경계·필드 이름이 붙으므로 본문은 사진보다 조금 크다. 여유분. */
const ENVELOPE_SLACK = 64 * 1024;

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
      "Content-Type": photo.mime,
      // 사진이 바뀌면 저장 시각도 바뀌므로 화면이 주소에 그 값을 붙여 캐시를 깬다.
      // 그래서 여기서는 길게 들고 있게 둔다 — 넉 장을 매 렌더마다 다시 받을 이유가 없다.
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** 한 자리에 사진을 넣는다. 이미 있으면 갈아끼운다. */
export async function POST(request: Request): Promise<Response> {
  // 파싱하기 **전에** 길이부터 본다. formData() 는 본문을 통째로 메모리에 올리므로,
  // 크기 판정을 그 뒤에 하면 거절할 사진도 일단 다 받아 놓는 꼴이 된다.
  // Content-Length 는 없을 수도 있고 거짓일 수도 있으니 이건 방어일 뿐이고,
  // 진짜 판정은 아래 checkPhoto 가 실제 바이트로 한다.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES + ENVELOPE_SLACK) {
    return NextResponse.json({ ok: false, message: PHOTO_TOO_LARGE_MESSAGE }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const target = readTarget({ month: form.get("month"), slot: form.get("slot") });
  if (!target.ok) {
    return NextResponse.json({ ok: false, message: target.message }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, message: "넣을 사진이 없습니다." }, { status: 400 });
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return NextResponse.json({ ok: false, message: PHOTO_TOO_LARGE_MESSAGE }, { status: 400 });
  }

  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  const check = checkPhoto({ slot: target.slot, base64: data });
  if (!check.ok) {
    return NextResponse.json({ ok: false, message: check.message }, { status: 400 });
  }

  // 이름은 사람에게 어떤 사진인지 알려주는 용도뿐이지만, 경로 조각이 남으면 화면에
  // 엉뚱한 것이 찍힌다. 첨부와 같은 정리를 쓴다.
  const fileName = cleanFileName(typeof file.name === "string" ? file.name : "");

  try {
    await savePhoto({
      month: target.month,
      slot: check.slot,
      fileName,
      mime: check.mime,
      data,
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
