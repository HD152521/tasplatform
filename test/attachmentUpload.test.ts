/**
 * 올릴 파일 판정.
 *
 * 이게 틀리면 겉으로 조용하다 — 파일이 큐를 거쳐 수집기까지 간 뒤 브라우저가 열리고
 * 나서야 실패한다. 사람은 수십 초 뒤에 이유 없는 실패만 보고, 다시 올려서 케이스에
 * 같은 파일을 두 번 붙인다. 그래서 판정을 여기서 못으로 박는다.
 *
 * 실제 케이스 번호·파일명은 쓰지 않는다. 이 저장소는 공개이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  checkUploadRequest,
  cleanFileName,
} from "../lib/attachmentUpload.ts";
import { UploadError, safeFileName } from "../lib/crushftp.ts";

const CASE = 20000001; // 자리표시자

test("정상 요청은 이름을 다듬어 통과한다", () => {
  const got = checkUploadRequest({ requestId: CASE, fileName: "note.txt", size: 12 });
  assert.equal(got.ok, true);
  assert.deepEqual(got, { ok: true, requestId: CASE, fileName: "note.txt" });
});

// 문자열로 온다(formData 는 전부 문자열이다). Number 로 못 바꾸면 조용히 NaN 이 되고
// 큐에는 케이스 없는 일이 들어간다.
test("케이스 번호가 문자열이어도 숫자로 받는다", () => {
  const got = checkUploadRequest({ requestId: String(CASE), fileName: "a.log", size: 1 });
  assert.equal(got.ok && got.requestId, CASE);
});

test("케이스 번호가 아니면 거절한다", () => {
  for (const bad of [undefined, null, "", "abc", 0, -1, 1.5, "12x"]) {
    const got = checkUploadRequest({ requestId: bad, fileName: "a.txt", size: 1 });
    assert.equal(got.ok, false, `통과하면 안 된다: ${String(bad)}`);
  }
});

// 수집기까지 가서야 "올릴 내용이 비어 있습니다" 로 끝난다. 사람 앞에서 먼저 말한다.
test("빈 파일은 거절한다", () => {
  const got = checkUploadRequest({ requestId: CASE, fileName: "a.txt", size: 0 });
  assert.equal(got.ok, false);
  assert.equal(got.ok === false && got.code, "invalid");
});

test("상한까지는 받고 한 바이트라도 넘으면 안내한다", () => {
  const edge = checkUploadRequest({ requestId: CASE, fileName: "a.bin", size: MAX_UPLOAD_BYTES });
  assert.equal(edge.ok, true, "상한 그 자체는 받아야 한다");

  const over = checkUploadRequest({
    requestId: CASE, fileName: "a.bin", size: MAX_UPLOAD_BYTES + 1,
  });
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.code, "too_large");
  // 안내 문구가 상한을 실제로 말해야 한다 — 숫자만 바꾸고 문구가 남으면 거짓말이 된다.
  assert.ok(
    over.ok === false && over.message.includes(MAX_UPLOAD_LABEL),
    "상한 표기가 안내 문구에 들어 있어야 한다",
  );
  assert.ok(over.ok === false && over.message.includes("포털"), "다른 길을 알려줘야 한다");
});

// 이름은 결국 CrushFTP 의 올릴 경로에 들어간다. 경로가 남으면 남의 폴더를 가리킨다.
test("이름에서 경로를 걷어낸다", () => {
  assert.equal(cleanFileName("../../etc/passwd"), "passwd");
  assert.equal(cleanFileName("C:\\temp\\report.pdf"), "report.pdf");
  assert.equal(cleanFileName("  spaced.txt  "), "spaced.txt");
});

test("쓸 이름이 남지 않으면 거절한다", () => {
  for (const bad of ["", "   ", ".", "..", "a/b/", "\u0001"]) {
    const got = checkUploadRequest({ requestId: CASE, fileName: bad, size: 1 });
    assert.equal(got.ok, false, `통과하면 안 된다: ${JSON.stringify(bad)}`);
  }
});

test("파일 이름이 문자열이 아니면 거절한다", () => {
  const got = checkUploadRequest({ requestId: CASE, fileName: undefined, size: 1 });
  assert.equal(got.ok, false);
});

/**
 * 웹 입구(cleanFileName)와 실제 경로를 만드는 쪽(crushftp.safeFileName)은 같은 규칙이어야
 * 한다. 웹은 클라이언트 번들에서도 쓰려고 의존성 없이 따로 들고 있는데, 두 곳이 갈라지면
 * 조용히 어긋난다 — 웹이 통과시킨 이름이 수집기에서 거절되거나(수십 초 뒤 실패),
 * 반대로 웹이 다듬은 이름과 실제로 올라간 이름이 달라진다.
 */
test("웹의 이름 다듬기가 수집기의 규칙과 같다", () => {
  const samples = [
    "note.txt", "report.pdf", "../../etc/passwd", "C:\\temp\\report.pdf",
    "  spaced.txt  ", "a/b/c.log", "한글이름.txt", "dots...txt", "no-ext",
  ];
  for (const raw of samples) {
    assert.equal(cleanFileName(raw), safeFileName(raw), `다르면 조용히 어긋난다: ${raw}`);
  }

  // 쓸 이름이 없는 입력은 한쪽은 빈 문자열, 한쪽은 예외로 거절한다. 판정 자체는 같아야 한다.
  for (const raw of ["", "   ", ".", "..", "a/b/"]) {
    assert.equal(cleanFileName(raw), "", `거절해야 한다: ${JSON.stringify(raw)}`);
    assert.throws(() => safeFileName(raw), UploadError, `거절해야 한다: ${JSON.stringify(raw)}`);
  }
});
