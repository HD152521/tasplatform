import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../collector/lock.ts";

function tempLock() {
  const dir = mkdtempSync(join(tmpdir(), "srlock-"));
  const file = join(dir, "collector.lock");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("두 번째 획득은 실패한다 (동시 실행 방지)", () => {
  const { file, cleanup } = tempLock();
  try {
    const release = acquireLock(file);
    assert.ok(release);
    assert.equal(acquireLock(file), null);
    release();
    const again = acquireLock(file);
    assert.ok(again);
    again();
  } finally { cleanup(); }
});

test("죽은 프로세스가 남긴 락은 회수한다", () => {
  const { file, cleanup } = tempLock();
  try {
    writeFileSync(file, JSON.stringify({ pid: 999999999, startedAt: "x" }), "utf8");
    const release = acquireLock(file);
    assert.ok(release, "죽은 PID 락은 회수되어야 한다");
    release();
  } finally { cleanup(); }
});

test("손상된 락 파일도 회수한다", () => {
  const { file, cleanup } = tempLock();
  try {
    writeFileSync(file, "not-json", "utf8");
    const release = acquireLock(file);
    assert.ok(release);
    release();
  } finally { cleanup(); }
});
