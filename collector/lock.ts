/**
 * 단일 인스턴스 보장.
 *
 * 계정 1개를 공유하므로 수집기가 동시에 두 개 돌면 서로 세션을 밀어낸다.
 * 락을 못 잡으면 조용히 종료하고, runs 에도 기록하지 않는다(실패가 아니라 '건너뜀').
 */
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LOCK_FILE } from "../lib/config.ts";

interface LockPayload {
  pid: number;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 락을 얻으면 해제 함수를 반환, 못 얻으면 null. */
export function acquireLock(file: string = LOCK_FILE): (() => void) | null {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    try {
      const held = JSON.parse(readFileSync(path, "utf8")) as LockPayload;
      if (isProcessAlive(held.pid)) return null;
      // 비정상 종료로 남은 락 -> 회수
    } catch {
      // 손상된 락 파일 -> 회수
    }
    rmSync(path, { force: true });
  }

  const payload: LockPayload = { pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(payload), "utf8");

  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(path, { force: true });
  };
}
