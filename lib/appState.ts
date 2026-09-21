/**
 * 프로세스 사이에 남겨야 하는 작은 값들.
 *
 * TAS 는 파일시스템이 ephemeral 이라(manifest.yml 머리말) 파일에 두면 재시작마다
 * 사라진다. 그래서 DB 에 둔다. 지금 쓰는 곳은 자동 요약의 워터마크 하나뿐이다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부른다.
 */
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";

/** 없으면 null. 빈 문자열과 "설정 안 됨" 을 구분한다. */
export async function getAppState(db: Db, key: string): Promise<string | null> {
  const row = await db.get<{ value: string }>(
    "SELECT value FROM app_state WHERE key = ?",
    [key],
  );
  return row === undefined ? null : row.value;
}

export async function setAppState(db: Db, key: string, value: string): Promise<void> {
  await db.run(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, isoNow()],
  );
}

/**
 * 값이 없을 때만 넣고, 최종적으로 자리잡은 값을 돌려준다.
 *
 * 워터마크처럼 "처음 한 번만 정해지고 그 뒤로는 안 바뀌는" 값에 쓴다.
 * 이미 있으면 기존 값을 그대로 돌려주므로 여러 번 불러도 안전하다.
 */
export async function initAppState(db: Db, key: string, value: string): Promise<string> {
  const existing = await getAppState(db, key);
  if (existing !== null) return existing;
  await setAppState(db, key, value);
  return value;
}
