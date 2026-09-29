/**
 * 답변 본문에 박혀 온 이미지 골라내기.
 *
 * 본문에는 우리가 보여줄 캡처보다 **메일 열람 추적 픽셀이 훨씬 많다**(실측 523개 스레드
 * 중 진짜 이미지는 238장, 나머지는 추적용). 그걸 같이 보여주면 답변마다 깨진 그림이
 * 줄줄이 붙는다. 반대로 너무 좁게 잡으면 진짜 캡처를 놓친다.
 *
 * 실제 케이스 번호·고객사 정보는 넣지 않는다. 이 저장소는 공개이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineImageIds, isFileId } from "../lib/inlineImages.ts";

const PORTAL = "https://api-broadcomcms-software.wolkenservicedesk.com/attachment/get_attachment_content";

function img(src: string): string {
  return `<div><p>본문입니다.</p><img src="${src}"><br></div>`;
}

test("포털 이미지의 id 를 뽑는다", () => {
  assert.deepEqual(inlineImageIds(img(`${PORTAL}?uniqueFileId=AbCd1234==`)), ["AbCd1234=="]);
});

test("숫자 id 도 받는다", () => {
  // 실측 두 가지다 — base64 와 숫자.
  assert.deepEqual(inlineImageIds(img(`${PORTAL}?uniqueFileId=1553875694105`)), ["1553875694105"]);
});

test("작은따옴표와 공백이 섞여도 읽는다", () => {
  const html = `<img  src = '${PORTAL}?uniqueFileId=Zz09' />`;
  assert.deepEqual(inlineImageIds(html), ["Zz09"]);
});

test("&amp; 로 적힌 주소도 읽는다", () => {
  const html = `<img src="${PORTAL}?uniqueFileId=Ab12&amp;from=int">`;
  assert.deepEqual(inlineImageIds(html), ["Ab12"], "뒤에 붙은 다른 파라미터는 버린다");
});

/* ------------------------------------------------------------------ *
 * 추적 픽셀은 거른다
 * ------------------------------------------------------------------ */

test("메일 추적 픽셀은 가져오지 않는다", () => {
  for (const src of [
    "https://pivotal.my.salesforce.com/servlet/servlet.ImageServer?oid=X&esid=Y",
    "https://jmailb.ktbizoffice.com/open.gif?id=1",
    "https://cdn.cookielaw.org/logo.png",
  ]) {
    assert.deepEqual(inlineImageIds(img(src)), [], `걸러야 한다: ${src}`);
  }
});

test("cid: 와 data: 는 가져오지 않는다", () => {
  assert.deepEqual(inlineImageIds(img("cid:part1.abc@example")), []);
  assert.deepEqual(inlineImageIds(img("data:image/png;base64,iVBORw0KGgo=")), []);
});

// 호스트만 비슷한 주소로 서버가 대리 요청을 보내면 안 된다.
test("비슷한 호스트에 속지 않는다", () => {
  assert.deepEqual(
    inlineImageIds(img("https://evil.com/attachment/get_attachment_content?uniqueFileId=x")),
    [],
  );
  assert.deepEqual(
    inlineImageIds(img("https://api-broadcomcms-software.wolkenservicedesk.com.evil.com/attachment/get_attachment_content?uniqueFileId=x")),
    [],
  );
});

/* ------------------------------------------------------------------ *
 * 그 밖
 * ------------------------------------------------------------------ */

test("같은 이미지가 여러 번 박혀도 한 번만 센다", () => {
  const one = `<img src="${PORTAL}?uniqueFileId=Same1">`;
  assert.deepEqual(inlineImageIds(one + "<p>인용</p>" + one), ["Same1"]);
});

test("나온 순서를 지킨다", () => {
  // 글과 그림의 짝이 어긋나면 읽기 어렵다.
  const html = [1, 2, 3].map((n) => `<img src="${PORTAL}?uniqueFileId=Id${n}">`).join("<p>사이</p>");
  assert.deepEqual(inlineImageIds(html), ["Id1", "Id2", "Id3"]);
});

test("이미지가 없으면 빈 목록", () => {
  assert.deepEqual(inlineImageIds(""), []);
  assert.deepEqual(inlineImageIds("<p>그냥 글</p>"), []);
});

/* ------------------------------------------------------------------ *
 * id 모양 검사 — 주소를 만들 때 그대로 들어간다
 * ------------------------------------------------------------------ */

test("쓸 수 있는 id 모양", () => {
  for (const ok of ["AbCd1234==", "1553875694105", "a/b+c=", "x_y-z.1"]) {
    assert.equal(isFileId(ok), true, ok);
  }
});

test("이상한 값은 거부한다", () => {
  for (const bad of ["", " ", "../etc/passwd", "a b", "a?b=1", "<script>", "가나다", "x".repeat(129)]) {
    assert.equal(isFileId(bad), false, JSON.stringify(bad));
  }
});
