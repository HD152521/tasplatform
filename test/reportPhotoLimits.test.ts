/**
 * 사진 상한·형식·픽셀 크기 판정.
 *
 * 이 판정이 새면 4MB 짜리 넉 장이 base64 로 DB 에 들어앉거나(행 하나가 5.4MB),
 * python-pptx 가 못 읽는 형식이 들어가 **보고서 만들 때** 터진다. 사진을 넣던 사람은
 * 이미 그 화면을 떠났고 실패는 며칠 뒤 다른 사람 앞에서 난다. 그래서 여기서 잠근다.
 *
 * 반대 방향도 함께 잠근다 — **저장 상한을 원본에 걸면 안 된다.** 휴대폰 사진은 한 장이
 * 3~15MB 라, 줄이기 전에 재면 현장에서 찍은 사진이 거의 다 거부당한다.
 *
 * 시험용 이미지는 코드로 만든다 — 이 저장소는 공개이고, 실제 현장 사진을 넣지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  MAX_ORIGINAL_BYTES,
  MAX_PHOTO_BYTES,
  MAX_PHOTO_EDGE,
  MAX_PHOTO_LABEL,
  PHOTO_ACCEPT,
  PHOTO_LONG_EDGE,
  PHOTO_SLOT_COUNT,
  checkPhoto,
  isPhotoSlot,
  readImageSize,
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

/** 실제 PNG 헤더를 갖춘 사진. 픽셀 내용은 필요 없으므로 IDAT 은 한 줄만 넣는다. */
function png(width = 1, height = 1): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  // 나머지(compression·filter·interlace)는 0 이 기본값이다.
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(1 + width * 3))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 실제 JPEG 마커 구조를 갖춘 사진.
 *
 * SOI → APP0(길이 있는 세그먼트, 건너뛰어야 한다) → SOF0(여기 크기가 있다) → EOI.
 * 길이 있는 세그먼트를 일부러 앞에 두어, 크기를 고정 위치에서 읽지 않는지 확인한다.
 */
function jpeg(width = 1, height = 1): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);   // 세그먼트 길이
  sof[4] = 8;                 // 정밀도
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;                 // 컴포넌트 수
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9]),
  ]);
}

test("만든 PNG·JPEG 가 실제 서명으로 시작한다", () => {
  assert.equal(png().subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(jpeg().subarray(0, 3).toString("hex"), "ffd8ff");
});

test("형식은 앞머리 바이트로 알아낸다", () => {
  assert.equal(sniffPhotoMime(png()), "image/png");
  assert.equal(sniffPhotoMime(jpeg()), "image/jpeg");
});

// WebP·HEIC 는 python-pptx 가 헤더를 못 읽는다. 이름이나 Content-Type 을 믿지 않는다.
test("JPEG·PNG 가 아니면 형식을 알아내지 못한다", () => {
  const webp = Buffer.concat([
    Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"),
  ]);
  assert.equal(sniffPhotoMime(webp), null);
  assert.equal(sniffPhotoMime(Buffer.from("GIF89a")), null);
  assert.equal(sniffPhotoMime(Buffer.alloc(0)), null);
});

test("헤더에서 가로·세로를 읽는다", () => {
  assert.deepEqual(readImageSize(png(1200, 1600)), { width: 1200, height: 1600 });
  assert.deepEqual(readImageSize(jpeg(1200, 1600)), { width: 1200, height: 1600 });
  // 길이 있는 세그먼트(APP0)를 건너뛰어야 나오는 값이다.
  assert.deepEqual(readImageSize(jpeg(3, 7)), { width: 3, height: 7 });
});

test("헤더가 잘렸으면 크기를 읽지 못한다", () => {
  assert.equal(readImageSize(png(10, 10).subarray(0, 20)), null);
  assert.equal(readImageSize(Buffer.from([0xff, 0xd8, 0xff])), null);
  assert.equal(readImageSize(Buffer.alloc(0)), null);
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
  const ok = checkPhoto({ slot: 1, bytes: png(1200, 1600) });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.slot, 1);
    assert.equal(ok.mime, "image/png");
    assert.equal(ok.width, 1200);
    assert.equal(ok.height, 1600);
    assert.equal(ok.bytes, png(1200, 1600).length);
  }
  assert.equal(checkPhoto({ slot: 4, bytes: jpeg(800, 600) }).ok, true);
});

// 상한 초과를 거부하는지 — 이것이 새면 DB 가 사진 보관소가 된다.
test("저장 상한을 넘는 사진은 거부한다", () => {
  // 앞에 제대로 된 JPEG 헤더를 두고 상한보다 한 바이트 크게 만든다.
  const head = jpeg(10, 10);
  const oversized = Buffer.concat([head, Buffer.alloc(MAX_PHOTO_BYTES)]);
  assert.ok(oversized.length > MAX_PHOTO_BYTES);
  const result = checkPhoto({ slot: 1, bytes: oversized });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "too_large");
    assert.match(result.message, new RegExp(MAX_PHOTO_LABEL));
  }
});

// 상한 바로 아래는 통과해야 한다 — 경계에서 한 칸 밀리면 멀쩡한 사진이 거부된다.
test("저장 상한과 정확히 같은 크기는 통과한다", () => {
  const head = jpeg(10, 10);
  const exact = Buffer.concat([head, Buffer.alloc(MAX_PHOTO_BYTES - head.length)]);
  assert.equal(exact.length, MAX_PHOTO_BYTES);
  assert.equal(checkPhoto({ slot: 2, bytes: exact }).ok, true);
});

// 바이트 상한만으로는 압축 폭탄을 못 막는다. 4MB 안에 드는 거대한 사진이 있다.
test("픽셀이 너무 많은 사진은 거부한다", () => {
  const bomb = png(MAX_PHOTO_EDGE + 1, 10);
  assert.ok(bomb.length < MAX_PHOTO_BYTES, "바이트 상한에는 걸리지 않아야 의미가 있다");
  const result = checkPhoto({ slot: 1, bytes: bomb });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "too_many_pixels");

  // 세로로 큰 것도 같다.
  const tall = checkPhoto({ slot: 1, bytes: png(10, MAX_PHOTO_EDGE + 1) });
  assert.equal(tall.ok, false);
});

test("픽셀 상한과 정확히 같은 크기는 통과한다", () => {
  assert.equal(checkPhoto({ slot: 1, bytes: png(MAX_PHOTO_EDGE, 10) }).ok, true);
});

// 앞머리는 맞는데 크기를 못 읽는 것은 통과시키면 안 된다 — 보고서 만들 때 터진다.
test("헤더가 깨진 사진은 거부한다", () => {
  const broken = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00]);
  const result = checkPhoto({ slot: 1, bytes: broken });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unsupported");
});

test("빈 사진과 잘못된 자리는 거부한다", () => {
  const empty = checkPhoto({ slot: 1, bytes: new Uint8Array(0) });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "invalid");

  const badSlot = checkPhoto({ slot: 7, bytes: png() });
  assert.equal(badSlot.ok, false);
  if (!badSlot.ok) assert.equal(badSlot.code, "invalid");
});

test("형식을 알 수 없으면 unsupported 로 거부한다", () => {
  const result = checkPhoto({ slot: 1, bytes: Buffer.from("not an image") });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unsupported");
});

/**
 * 이것이 이번에 실제로 났던 결함이다 — 저장 상한을 **고른 원본**에 걸면, 줄여서
 * 넣으라고 만든 기능이 줄이기도 전에 휴대폰 사진을 전부 거부한다.
 */
test("고를 수 있는 원본 상한이 저장 상한보다 넉넉하다", () => {
  assert.ok(MAX_ORIGINAL_BYTES > MAX_PHOTO_BYTES);
  // 1억 화소 휴대폰 사진도 20MB 안쪽이다.
  assert.ok(MAX_ORIGINAL_BYTES >= 20 * 1024 * 1024);
});

// 줄인 결과가 픽셀 상한 안에 들어야 화면이 만든 사진이 서버에서 거부되지 않는다.
test("줄이는 길이가 픽셀 상한보다 작다", () => {
  assert.ok(PHOTO_LONG_EDGE < MAX_PHOTO_EDGE);
});

// 파일 고르기 창이 다른 형식을 먼저 보여주면, 사람은 고르고 나서 거부당한다.
test("accept 값이 받아들이는 형식과 같다", () => {
  assert.equal(PHOTO_ACCEPT, "image/jpeg,image/png");
});
