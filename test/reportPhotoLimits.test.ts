/**
 * 사진 상한·형식 판정.
 *
 * 이 판정이 새면 4MB 짜리 넉 장이 base64 로 DB 에 들어앉거나(행 하나가 5.4MB),
 * python-pptx 가 못 읽는 형식이 들어가 **보고서 만들 때** 터진다. 사진을 넣던 사람은
 * 이미 그 화면을 떠났고 실패는 며칠 뒤 다른 사람 앞에서 난다. 그래서 여기서 잠근다.
 *
 * 시험용 이미지는 코드로 만든다 — 이 저장소는 공개이고, 실제 현장 사진을 넣지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  MAX_PHOTO_BYTES,
  MAX_PHOTO_LABEL,
  PHOTO_ACCEPT,
  PHOTO_SLOT_COUNT,
  base64Bytes,
  checkPhoto,
  isPhotoSlot,
  sniffPhotoMime,
} from "../lib/reportPhotoLimits.ts";

/** PNG 청크 하나. 길이 + 종류 + 내용 + CRC32. */
function chunk(kind: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  const named = Buffer.concat([Buffer.from(kind, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(named), 0);
  return Buffer.concat([head, named, crc]);
}

function crc32(data: Buffer): number {
  let acc = 0xffffffff;
  for (const byte of data) {
    acc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      acc = acc & 1 ? (acc >>> 1) ^ 0xedb88320 : acc >>> 1;
    }
  }
  return (acc ^ 0xffffffff) >>> 0;
}

/** 1×1 검정 PNG 를 만든다. 실제 PNG 헤더를 갖추므로 형식 판정을 진짜로 통과한다. */
function tinyPng(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);   // width
  ihdr.writeUInt32BE(1, 4);   // height
  ihdr[8] = 8;                // bit depth
  ihdr[9] = 2;                // color type: truecolor
  // 나머지(compression·filter·interlace)는 0 이 기본값이다.
  const scanline = Buffer.from([0x00, 0x00, 0x00, 0x00]); // 필터 0 + RGB
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanline)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** JPEG 앞머리(SOI + APP0)만 갖춘 바이트. 형식 판정은 앞 세 바이트로 한다. */
function jpegHead(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
}

const PNG_B64 = tinyPng().toString("base64");
const JPEG_B64 = jpegHead().toString("base64");

test("만든 PNG 가 실제 PNG 서명으로 시작한다", () => {
  assert.equal(tinyPng().subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("형식은 base64 앞머리로 알아낸다", () => {
  assert.equal(sniffPhotoMime(PNG_B64), "image/png");
  assert.equal(sniffPhotoMime(JPEG_B64), "image/jpeg");
});

// WebP·HEIC 는 python-pptx 가 헤더를 못 읽는다. 이름이나 Content-Type 을 믿지 않는다.
test("JPEG·PNG 가 아니면 형식을 알아내지 못한다", () => {
  const webp = Buffer.concat([
    Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"),
  ]);
  assert.equal(sniffPhotoMime(webp.toString("base64")), null);
  assert.equal(sniffPhotoMime(Buffer.from("GIF89a").toString("base64")), null);
  assert.equal(sniffPhotoMime(""), null);
});

test("base64 길이로 실제 바이트 수를 센다", () => {
  for (const size of [1, 2, 3, 4, 100, 1023, 4096]) {
    assert.equal(base64Bytes(Buffer.alloc(size).toString("base64")), size);
  }
});

test("자리 번호는 1..4 만 받는다", () => {
  for (let slot = 1; slot <= PHOTO_SLOT_COUNT; slot += 1) {
    assert.ok(isPhotoSlot(slot), `${slot} 은 유효해야 한다`);
    assert.ok(isPhotoSlot(String(slot)), `"${slot}" 도 유효해야 한다`);
  }
  for (const bad of [0, -1, 5, 1.5, "", "a", null, undefined, {}]) {
    assert.equal(isPhotoSlot(bad), false, `${String(bad)} 은 거부해야 한다`);
  }
});

test("제대로 된 PNG·JPEG 는 통과한다", () => {
  const png = checkPhoto({ slot: 1, base64: PNG_B64 });
  assert.equal(png.ok, true);
  if (png.ok) {
    assert.equal(png.slot, 1);
    assert.equal(png.mime, "image/png");
    assert.equal(png.bytes, tinyPng().length);
  }
  assert.equal(checkPhoto({ slot: 4, base64: JPEG_B64 }).ok, true);
});

// 상한 초과를 거부하는지 — 이것이 새면 DB 가 사진 보관소가 된다.
test("상한을 넘는 사진은 거부한다", () => {
  // JPEG 서명을 앞에 두고 상한보다 한 바이트 크게 만든다.
  const oversized = Buffer.concat([jpegHead(), Buffer.alloc(MAX_PHOTO_BYTES)]);
  assert.ok(oversized.length > MAX_PHOTO_BYTES);
  const result = checkPhoto({ slot: 1, base64: oversized.toString("base64") });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "too_large");
    assert.match(result.message, new RegExp(MAX_PHOTO_LABEL));
  }
});

// 상한 바로 아래는 통과해야 한다 — 경계에서 한 칸 밀리면 멀쩡한 사진이 거부된다.
test("상한과 정확히 같은 크기는 통과한다", () => {
  const exact = Buffer.concat([jpegHead(), Buffer.alloc(MAX_PHOTO_BYTES - jpegHead().length)]);
  assert.equal(exact.length, MAX_PHOTO_BYTES);
  assert.equal(checkPhoto({ slot: 2, base64: exact.toString("base64") }).ok, true);
});

test("빈 사진과 잘못된 자리는 거부한다", () => {
  const empty = checkPhoto({ slot: 1, base64: "" });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "invalid");

  const badSlot = checkPhoto({ slot: 7, base64: PNG_B64 });
  assert.equal(badSlot.ok, false);
  if (!badSlot.ok) assert.equal(badSlot.code, "invalid");
});

test("형식을 알 수 없으면 unsupported 로 거부한다", () => {
  const result = checkPhoto({ slot: 1, base64: Buffer.from("not an image").toString("base64") });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unsupported");
});

// 파일 고르기 창이 다른 형식을 먼저 보여주면, 사람은 고르고 나서 거부당한다.
test("accept 값이 받아들이는 형식과 같다", () => {
  assert.equal(PHOTO_ACCEPT, "image/jpeg,image/png");
});
