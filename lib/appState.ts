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
 * 값이 없을 때만 넣고, 자리잡은 값과 **내가 넣었는지**를 함께 돌려준다.
 *
 * 워터마크처럼 "처음 한 번만 정해지고 그 뒤로는 안 바뀌는" 값에 쓴다.
 * 이미 있으면 기존 값을 그대로 돌려주므로 여러 번 불러도 안전하다.
 *
 * ## `inserted` 를 왜 돌려주는가
 *
 * 호출부는 "이번이 첫 실행인가" 를 알아야 한다 — 첫 실행에는 아무것도 하지 않아야
 * 하기 때문이다(그 순간 이미 끝나 있던 건이 전부 대상이 되면 안 된다).
 *
 * 한때 호출부가 그것을 `stored === String(Date.now())` 로 **추측**했다
 * (lib/autopublish.ts readSince, collector/prewarm.ts). 그 비교는 두 호출이 **같은
 * 밀리초**에 떨어지면 참이 되어, 두 번째 호출도 "첫 실행" 으로 보고된다. 느린 PC 에서는
 * 안 걸리고 빠른 CI 러너(911건 11초)에서만 깨졌다 — 테스트가 플래키한 게 아니라 판정이
 * 틀렸다. 넣었는지 아는 쪽은 이 함수뿐이므로 여기서 답한다.
 *
 * 넣기는 `DO NOTHING` 으로 한다. 두 프로세스가 동시에 처음을 맞으면 **먼저 넣은 값이
 * 남아야 한다** — `DO UPDATE` 면 나중 값이 워터마크를 밀어 버린다. 경합에서 진 쪽은
 * 자리잡은 값이 자기 값과 달라 `inserted: false` 를 받는다.
 */
export async function initAppState(
  db: Db,
  key: string,
  value: string,
): Promise<{ value: string; inserted: boolean }> {
  const existing = await getAppState(db, key);
  if (existing !== null) return { value: existing, inserted: false };

  await db.run(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO NOTHING`,
    [key, value, isoNow()],
  );
  const settled = await getAppState(db, key);
  return { value: settled ?? value, inserted: settled === value };
}
