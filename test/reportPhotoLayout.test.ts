/**
 * 사진 배치 — 장수가 몇이면 슬라이드가 몇 장 생기고 어디에 놓이는가.
 *
 * 이 규칙이 틀리면 **파일을 열어 보기 전까지 아무도 모른다.** 사진이 겹쳐 놓이거나
 * 빈 사진틀이 남은 보고서가 그대로 고객에게 나간다. 그래서 0·1·2·3·4 전부를 잠근다.
 *
 * 좌표는 실제 고객 보고서에서 잰 값이다. 숫자를 바꾸려면 다시 재고 이 시험을 고쳐야 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PHOTOS_PER_SLIDE,
  PHOTO_CHIP,
  PHOTO_HEIGHT,
  PHOTO_LEFT,
  PHOTO_TITLE,
  PHOTO_TOP,
  PHOTO_WIDTH,
  layoutPhotoSlides,
  photoSeatLabel,
} from "../lib/reportPhotoLayout.ts";
import { PHOTO_SLOT_COUNT } from "../lib/reportPhotoLimits.ts";

// 0장이면 슬라이드를 아예 붙이지 않는다. 빈 사진틀이 남은 보고서가 가장 나쁘다.
test("0장이면 슬라이드가 생기지 않는다", () => {
  assert.deepEqual(layoutPhotoSlides(0), []);
});

test("1장이면 슬라이드 1장에 왼쪽만", () => {
  const slides = layoutPhotoSlides(1);
  assert.equal(slides.length, 1);
  assert.equal(slides[0]?.page, 1);
  assert.equal(slides[0]?.total, 1);
  assert.equal(slides[0]?.items.length, 1);
  assert.equal(slides[0]?.items[0]?.left, PHOTO_LEFT[0]);
});

test("2장이면 슬라이드 1장에 좌·우", () => {
  const slides = layoutPhotoSlides(2);
  assert.equal(slides.length, 1);
  assert.equal(slides[0]?.items.length, 2);
  assert.deepEqual(slides[0]?.items.map((i) => i.left), [PHOTO_LEFT[0], PHOTO_LEFT[1]]);
  assert.deepEqual(slides[0]?.items.map((i) => i.index), [0, 1]);
});

// 3장은 뒷장이 반만 찬다. 앞장을 먼저 채우고 남은 한 장이 뒷장 왼쪽이다.
test("3장이면 슬라이드 2장 — 앞장 좌·우, 뒷장 왼쪽만", () => {
  const slides = layoutPhotoSlides(3);
  assert.equal(slides.length, 2);
  assert.deepEqual(slides[0]?.items.map((i) => i.index), [0, 1]);
  assert.deepEqual(slides[1]?.items.map((i) => i.index), [2]);
  assert.equal(slides[1]?.items[0]?.left, PHOTO_LEFT[0]);
  assert.deepEqual(slides.map((s) => [s.page, s.total]), [[1, 2], [2, 2]]);
});

// 요청받은 기본 형태. 1번→A왼, 2번→A오른, 3번→B왼, 4번→B오른.
test("4장이면 슬라이드 2장에 2장씩, 받은 순서대로 좌→우·앞→뒤", () => {
  const slides = layoutPhotoSlides(4);
  assert.equal(slides.length, 2);
  assert.deepEqual(
    slides.flatMap((s) => s.items.map((i) => [i.index, i.left])),
    [[0, PHOTO_LEFT[0]], [1, PHOTO_LEFT[1]], [2, PHOTO_LEFT[0]], [3, PHOTO_LEFT[1]]],
  );
});

// top·폭·높이는 두 자리가 공유한다. 하나만 어긋나도 나란한 두 장의 줄이 안 맞는다.
test("모든 자리가 같은 top·폭·높이를 쓴다", () => {
  for (const item of layoutPhotoSlides(4).flatMap((s) => s.items)) {
    assert.equal(item.top, PHOTO_TOP);
    assert.equal(item.width, PHOTO_WIDTH);
    assert.equal(item.height, PHOTO_HEIGHT);
  }
});

// 실제 고객 보고서에서 잰 값. 바꾸려면 다시 재야 한다.
test("좌표는 실측값 그대로다", () => {
  assert.deepEqual([...PHOTO_LEFT], [1.45, 5.42]);
  assert.equal(PHOTO_TOP, 1.5);
  assert.equal(PHOTO_WIDTH, 3.9);
  assert.equal(PHOTO_HEIGHT, 5.5);
  assert.equal(PHOTOS_PER_SLIDE, 2);
  assert.equal(PHOTO_SLOT_COUNT, 4);
});

// 사진이 슬라이드 아래로 넘치면 잘려 나간다. 슬라이드 높이는 7.5인치다.
test("사진 자리가 슬라이드 안에 들어간다", () => {
  assert.ok(PHOTO_TOP + PHOTO_HEIGHT <= 7.5);
  assert.ok((PHOTO_LEFT[1] ?? 0) + PHOTO_WIDTH <= 13.34);
  // 좌·우가 겹치지 않는다.
  assert.ok((PHOTO_LEFT[0] ?? 0) + PHOTO_WIDTH <= (PHOTO_LEFT[1] ?? 0));
});

// 자리가 넷뿐이다. 다섯 번째를 놓을 곳이 없으므로 잘라낸다(마지막 방어선).
test("자리 수를 넘겨도 4장까지만 배치한다", () => {
  const slides = layoutPhotoSlides(9);
  assert.equal(slides.flatMap((s) => s.items).length, PHOTO_SLOT_COUNT);
  assert.equal(slides.length, 2);
});

test("장수가 숫자가 아니거나 음수면 빈 배열이다", () => {
  assert.deepEqual(layoutPhotoSlides(-1), []);
  assert.deepEqual(layoutPhotoSlides(1.5), []);
  assert.deepEqual(layoutPhotoSlides(Number.NaN), []);
});

// 제목은 실제 고객 보고서의 그 장과 같아야 한다.
test("구획 번호와 제목은 04 / PaaS 다", () => {
  assert.equal(PHOTO_CHIP, "04");
  assert.equal(PHOTO_TITLE, "PaaS");
});

test("자리 이름이 사람이 읽는 위치와 맞는다", () => {
  assert.equal(photoSeatLabel(0), "슬라이드 1 · 왼쪽");
  assert.equal(photoSeatLabel(1), "슬라이드 1 · 오른쪽");
  assert.equal(photoSeatLabel(2), "슬라이드 2 · 왼쪽");
  assert.equal(photoSeatLabel(3), "슬라이드 2 · 오른쪽");
});
