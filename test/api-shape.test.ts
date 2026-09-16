import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { toEpochMs } from "../lib/dates.ts";
import type { SearchResultItem } from "../lib/types.ts";

// captured/ 는 조사단계 캡처(실제 고객 SR 응답)라 커밋하지 않는다(.gitignore).
// 배포/CI 처럼 픽스처가 없는 환경에서는 이 테스트를 건너뛴다.
const FIXTURE = "captured/065_v3.json";

/** 캡처된 실제 목록 응답이 우리가 기대하는 필드를 갖는지 확인한다. */
test("목록 응답이 기대한 스키마를 만족한다", { skip: existsSync(FIXTURE) ? false : "captured 픽스처 없음" }, () => {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    response_preview: string;
  };
  const body = JSON.parse(raw.response_preview) as {
    status: string;
    data: { SearchResultList: SearchResultItem[] };
  };

  assert.equal(body.status, "Success");
  const rows = body.data.SearchResultList;
  assert.ok(rows.length > 0);

  for (const row of rows) {
    assert.equal(typeof row.requestId, "number");
    assert.equal(typeof row.requestIdFormatted, "string");
    assert.equal(typeof row.requestDesc, "string");
    assert.equal(typeof row.statusAliasName, "string");
    assert.equal(typeof row.lastUpdated, "string");
    assert.notEqual(toEpochMs(row.createdOn), null, `createdOn 파싱 실패: ${row.createdOn}`);
    assert.notEqual(toEpochMs(row.lastUpdated), null, `lastUpdated 파싱 실패: ${row.lastUpdated}`);
  }
});
