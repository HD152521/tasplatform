/**
 * 첨부 업로드 프로토콜의 순수한 부분.
 *
 * 네트워크가 필요한 부분은 여기서 재지 않는다. 대신 **틀리면 조용히 잘못 올라가는**
 * 계산들을 잠근다 — 올릴 경로, c2f 토큰, 조각 경계, 서버 응답 읽기.
 * 경로가 틀리면 남의 폴더에 올라가고, c2f 가 틀리면 다른 세션에서만 실패한다.
 *
 * 실제 케이스 번호·고객사 번호는 쓰지 않는다. 이 저장소는 공개이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CookieJar } from "../collector/cookieJar.ts";
import {
  CHUNK_BYTES,
  UPLOAD_FOLDER,
  UploadError,
  c2fFrom,
  chunkRanges,
  fileUrlFor,
  parseFilePath,
  readCommandResult,
  readMd5,
  safeFileName,
  uploadPathFor,
} from "../lib/crushftp.ts";

const SITE = "10000001";   // 자리표시자
const CASE = 20000002;     // 자리표시자

/* ------------------------------------------------------------------ *
 * 올릴 경로
 * ------------------------------------------------------------------ */

test("경로는 고객사/케이스/files_from_customer 아래로 간다", () => {
  assert.equal(
    uploadPathFor(SITE, CASE, "bundle.zip"),
    `/${SITE}/${CASE}/${UPLOAD_FOLDER}/bundle.zip`,
  );
});

// 루트에는 쓰기 권한이 없다. 폴더 이름이 바뀌면 전부 실패한다.
test("폴더 이름이 바뀌면 알아챈다", () => {
  assert.equal(UPLOAD_FOLDER, "files_from_customer");
});

test("파일명에 섞인 경로는 걷어낸다", () => {
  assert.equal(safeFileName("C:\\Users\\me\\log.txt"), "log.txt");
  assert.equal(safeFileName("/var/log/syslog"), "syslog");
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
});

test("이름이 남지 않으면 거부한다", () => {
  for (const bad of ["", "   ", "..", "/", "a/../"]) {
    assert.throws(() => safeFileName(bad), UploadError, `허용하면 안 된다: ${JSON.stringify(bad)}`);
  }
});

test("고객사·케이스 번호가 숫자가 아니면 거부한다", () => {
  assert.throws(() => uploadPathFor("../etc", CASE, "a.txt"), UploadError);
  assert.throws(() => uploadPathFor("12 3", CASE, "a.txt"), UploadError);
  assert.throws(() => uploadPathFor(SITE, 0, "a.txt"), UploadError);
  assert.throws(() => uploadPathFor(SITE, -1, "a.txt"), UploadError);
});

test("한글 파일명은 그대로 둔다", () => {
  assert.match(uploadPathFor(SITE, CASE, "점검결과.txt"), /점검결과\.txt$/);
});

/* ------------------------------------------------------------------ *
 * c2f — CrushAuth 쿠키의 마지막 4글자
 *
 * 캡처에서는 늘 같은 값이라 상수로 볼 뻔했다. 상수로 박았으면 **다른 세션에서만**
 * 실패했을 것이고, 그건 재현이 어렵다.
 * ------------------------------------------------------------------ */

function jarWith(cookies: Array<{ name: string; value: string; domain: string }>): CookieJar {
  return new CookieJar(cookies.map((c) => ({ ...c, path: "/" })));
}

test("CrushAuth 의 마지막 4글자를 쓴다", () => {
  const jar = jarWith([
    { name: "CrushAuth", value: "1759000000000_AbCdEfGhIjKlBb30", domain: "supportftp.broadcom.com" },
  ]);
  assert.equal(c2fFrom(jar), "Bb30");
});

test("점 붙은 도메인도 같은 쿠키로 본다", () => {
  const jar = jarWith([
    { name: "CrushAuth", value: "xxxxxxxxWXYZ", domain: ".supportftp.broadcom.com" },
  ]);
  assert.equal(c2fFrom(jar), "WXYZ");
});

test("다른 호스트의 같은 이름 쿠키는 쓰지 않는다", () => {
  const jar = jarWith([{ name: "CrushAuth", value: "aaaaBBBB", domain: "example.com" }]);
  assert.throws(() => c2fFrom(jar), UploadError);
});

test("쿠키가 없으면 세션 문제로 알린다", () => {
  try {
    c2fFrom(jarWith([]));
    assert.fail("던져야 한다");
  } catch (error) {
    assert.ok(error instanceof UploadError);
    assert.equal(error.code, "session");
    assert.match(error.message, /다시 로그인/);
  }
});

/* ------------------------------------------------------------------ *
 * 조각
 * ------------------------------------------------------------------ */

test("한 조각보다 작으면 조각 하나다", () => {
  assert.deepEqual(chunkRanges(100), [{ start: 0, end: 100 }]);
});

test("마지막 조각만 작다", () => {
  const total = CHUNK_BYTES * 3 + 7;
  const ranges = chunkRanges(total);
  assert.equal(ranges.length, 4);
  assert.equal(ranges[3]?.end, total);
  assert.equal((ranges[3]?.end ?? 0) - (ranges[3]?.start ?? 0), 7);
  // 빈틈도 겹침도 없어야 한다 — 어느 쪽이든 파일이 깨진다.
  for (let i = 1; i < ranges.length; i += 1) {
    assert.equal(ranges[i]?.start, ranges[i - 1]?.end);
  }
});

test("딱 떨어지면 남는 조각을 만들지 않는다", () => {
  const ranges = chunkRanges(CHUNK_BYTES * 2);
  assert.equal(ranges.length, 2);
});

test("빈 파일은 거부한다", () => {
  assert.throws(() => chunkRanges(0), UploadError);
});

/* ------------------------------------------------------------------ *
 * 응답 읽기
 * ------------------------------------------------------------------ */

test("명령 결과를 읽는다", () => {
  const xml = '<?xml version="1.0"?><commandResult><response>10800</response></commandResult>';
  assert.equal(readCommandResult(xml), "10800");
});

test("md5 를 읽는다", () => {
  const xml = "<commandResult><response></response><md5>604073f743cfb26486e8faab65f25b1b</md5></commandResult>";
  assert.equal(readMd5(xml), "604073f743cfb26486e8faab65f25b1b");
});

test("md5 가 없으면 null — 확인 없이 성공으로 보지 않는다", () => {
  assert.equal(readMd5("<commandResult><response>ok</response></commandResult>"), null);
  assert.equal(readMd5("로그인 화면 HTML"), null);
});

test("md5 모양이 아니면 읽지 않는다", () => {
  assert.equal(readMd5("<md5>not-a-hash</md5>"), null);
});

/* ------------------------------------------------------------------ *
 * 첨부 위치 읽기
 *
 * 포털이 주는 링크는 파일이 아니라 JS 로 이동시키는 페이지다. 그래서 그 주소를
 * 그대로 받으면 HTML 이 온다 — 첨부 다운로드가 안 되던 이유다.
 * ------------------------------------------------------------------ */

const REDIRECT = "https://supportftp.broadcom.com/WebInterface/redirect.html";

test("filePath 에서 고객사·케이스·경로를 뽑는다", () => {
  const ref = parseFilePath(`${REDIRECT}?filePath=${SITE}/${CASE}/${UPLOAD_FOLDER}/om_restore.sh`);
  assert.equal(ref?.site, SITE);
  assert.equal(ref?.caseId, CASE);
  assert.equal(ref?.path, `${SITE}/${CASE}/${UPLOAD_FOLDER}/om_restore.sh`);
});

test("앞에 붙은 슬래시는 걷어낸다", () => {
  const ref = parseFilePath(`${REDIRECT}?filePath=/${SITE}/${CASE}/${UPLOAD_FOLDER}/a.txt`);
  assert.equal(ref?.path, `${SITE}/${CASE}/${UPLOAD_FOLDER}/a.txt`);
});

test("경로 이탈은 거부한다", () => {
  assert.equal(parseFilePath(`${REDIRECT}?filePath=${SITE}/${CASE}/../../etc/passwd`), null);
  assert.equal(parseFilePath(`${REDIRECT}?filePath=./${SITE}/${CASE}/a.txt`), null);
});

test("허용하지 않는 호스트는 거부한다", () => {
  assert.equal(parseFilePath(`https://example.com/WebInterface/redirect.html?filePath=${SITE}/${CASE}/a.txt`), null);
});

test("모양이 다르면 null — 경로를 지어내지 않는다", () => {
  assert.equal(parseFilePath(""), null);
  assert.equal(parseFilePath("not a url"), null);
  assert.equal(parseFilePath(`${REDIRECT}?filePath=`), null);
  assert.equal(parseFilePath(`${REDIRECT}?site=${SITE}&case=${CASE}`), null, "업로드용 링크는 파일 링크가 아니다");
  assert.equal(parseFilePath(`${REDIRECT}?filePath=abc/def/a.txt`), null, "숫자가 아닌 고객사·케이스");
});

test("받아올 주소를 만든다", () => {
  const ref = parseFilePath(`${REDIRECT}?filePath=${SITE}/${CASE}/${UPLOAD_FOLDER}/a.txt`);
  assert.equal(fileUrlFor(ref!), `https://supportftp.broadcom.com/${SITE}/${CASE}/${UPLOAD_FOLDER}/a.txt`);
});

test("이름에 공백이나 한글이 있어도 주소가 깨지지 않는다", () => {
  const ref = parseFilePath(`${REDIRECT}?filePath=${SITE}/${CASE}/${UPLOAD_FOLDER}/점검 결과.txt`);
  const url = fileUrlFor(ref!);
  assert.doesNotThrow(() => new URL(url));
  assert.ok(!url.includes(" "), "공백이 그대로 남으면 요청이 깨진다");
});
