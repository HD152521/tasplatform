import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dropTargetSlots,
  splitByPhotoMime,
  type SeatState,
} from "../lib/reportPhotoDrop.ts";
import { PHOTO_SLOT_COUNT } from "../lib/reportPhotoLimits.ts";

/** 네 자리. filled 에 적은 번호만 차 있다. */
function seats(...filled: number[]): SeatState[] {
  return Array.from({ length: PHOTO_SLOT_COUNT }, (_, i) => ({
    slot: i + 1,
    filled: filled.includes(i + 1),
  }));
}

function file(name: string, type: string) {
  return { name, type };
}

/* ------------------------------------------------------------------ *
 * 칸 바깥에 놓기 — 빈 자리만 앞에서부터
 * ------------------------------------------------------------------ */

test("빈 칸에 네 장을 놓으면 1~4 자리에 차례로 들어간다", () => {
  assert.deepEqual(dropTargetSlots(seats(), 4), [1, 2, 3, 4]);
});

test("한 장만 놓으면 첫 빈 자리 하나만 쓴다", () => {
  assert.deepEqual(dropTargetSlots(seats(), 1), [1]);
});

// 들어 있는 사진을 끌어다 놓기로 덮어 버리면, 덮인 사진은 되돌릴 방법이 없다.
test("칸 바깥에 놓으면 이미 든 자리는 건드리지 않는다", () => {
  assert.deepEqual(dropTargetSlots(seats(1, 3), 2), [2, 4]);
});

test("빈 자리보다 많이 놓으면 들어가는 만큼만 돌려준다", () => {
  assert.deepEqual(dropTargetSlots(seats(1, 2, 3), 3), [4]);
});

test("빈 자리가 없으면 아무 자리도 돌려주지 않는다", () => {
  assert.deepEqual(dropTargetSlots(seats(1, 2, 3, 4), 2), []);
});

/* ------------------------------------------------------------------ *
 * 자리를 집어 놓기 — 그 자리부터, 덮어쓰기까지
 * ------------------------------------------------------------------ */

// 자리를 집어 놓은 것은 "여기에 이걸" 이라는 뜻이다. 비어 있는 뒤 자리로
// 비켜 가면 사람이 지목한 곳과 들어간 곳이 달라진다.
test("자리를 집어 놓으면 이미 들어 있어도 그 자리를 쓴다", () => {
  assert.deepEqual(dropTargetSlots(seats(1, 2, 3, 4), 1, 2), [2]);
});

test("자리를 집어 여러 장을 놓으면 그 자리부터 아래로 채운다", () => {
  assert.deepEqual(dropTargetSlots(seats(), 3, 2), [2, 3, 4]);
});

test("집은 자리부터 남은 칸보다 많이 놓으면 끝 자리에서 멈춘다", () => {
  assert.deepEqual(dropTargetSlots(seats(), 3, 3), [3, 4]);
});

test("마지막 자리를 집으면 한 자리만 쓴다", () => {
  assert.deepEqual(dropTargetSlots(seats(), 4, 4), [4]);
});

/* ------------------------------------------------------------------ *
 * 끝값
 * ------------------------------------------------------------------ */

test("놓은 것이 없으면 자리도 없다", () => {
  assert.deepEqual(dropTargetSlots(seats(), 0), []);
});

/* ------------------------------------------------------------------ *
 * 형식 가리기
 * ------------------------------------------------------------------ */

test("JPEG 와 PNG 는 받는다", () => {
  const got = splitByPhotoMime([file("a.jpg", "image/jpeg"), file("b.png", "image/png")]);
  assert.deepEqual(got.taken.map((f) => f.name), ["a.jpg", "b.png"]);
  assert.deepEqual(got.left, []);
});

/*
 * HEIC·WebP 는 **입구에서** 막는다. 통과시키면 python-pptx 가 헤더를 못 읽어
 * 보고서를 만드는 단계에서 터지는데, 사진을 넣던 사람은 이미 그 화면을 떠났다.
 */
test("HEIC·WebP 는 받지 않고 이름을 돌려준다", () => {
  const got = splitByPhotoMime([
    file("ok.jpg", "image/jpeg"),
    file("phone.heic", "image/heic"),
    file("shot.webp", "image/webp"),
  ]);
  assert.deepEqual(got.taken.map((f) => f.name), ["ok.jpg"]);
  assert.deepEqual(got.left, ["phone.heic", "shot.webp"]);
});

// 폴더나 문서를 함께 끌어왔을 때. 형식이 비어 있는 것도 걸러야 한다.
test("형식이 비어 있거나 사진이 아니면 받지 않는다", () => {
  const got = splitByPhotoMime([
    file("폴더", ""),
    file("보고서.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
  ]);
  assert.deepEqual(got.taken, []);
  assert.deepEqual(got.left, ["폴더", "보고서.pptx"]);
});

test("받을 것이 하나도 없으면 taken 이 빈다", () => {
  const got = splitByPhotoMime([file("a.gif", "image/gif")]);
  assert.deepEqual(got.taken, []);
  assert.deepEqual(got.left, ["a.gif"]);
});

test("아무것도 놓지 않으면 양쪽이 빈다", () => {
  const got = splitByPhotoMime([]);
  assert.deepEqual(got.taken, []);
  assert.deepEqual(got.left, []);
});
