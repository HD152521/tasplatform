/**
 * 정기점검 보고서 사진 저장.
 *
 * ## 왜 DB 인가
 *
 * TAS 는 파일시스템이 ephemeral 이라(manifest.yml 머리말) 디스크에 두면 재시작마다
 * 사라진다. 사진을 넣고 점심을 먹고 온 사람이 다시 넣어야 하는 일이 생긴다.
 * base64 TEXT 로 두는 것도 attachment_jobs.payload 와 같은 이유다 — SQLite 의 BLOB 과
 * Postgres 의 BYTEA 를 가르지 않는다.
 *
 * ## 왜 그 달 것만 남기나
 *
 * 사진은 보고서를 만들면 쓸 일이 없다. 그런데 장당 최대 4MB 씩 넉 장이라, 달마다 쌓이면
 * DB 가 사진 보관소가 된다. 그래서 **쓰는 순간 다른 달 것을 치운다** — 보관 기간을
 * 따로 돌리는 cron 을 만들지 않으려는 것이기도 하다. 지난달 사진이 필요하면 그 달
 * 보고서 파일 안에 이미 들어 있다.
 *
 * ## 건너뜀은 왜 따로 저장하나
 *
 * "아직 안 정했다" 와 "사진 없이 가기로 했다" 는 다르다. 전자는 보고서를 만들 때
 * "사진 없이 만들까요?" 를 물어야 하고 후자는 묻지 않는다. 사진 행이 없는 것만으로는
 * 둘을 구분할 수 없어서 app_state 에 한 줄 남긴다.
 *
 * server-only 를 붙이지 않는다 — 시험이 이 함수들을 직접 부른다(node --test 는
 * react-server 조건 없이 돌아서 server-only 가 즉시 던진다). appState.ts·attachmentJobs.ts
 * 와 같은 이유·같은 모양이다. 화면 쪽에서 실수로 물어도 lib/db.ts 가 브라우저 번들에
 * 들어가지 못해 빌드가 먼저 깨진다. 화면이 쓰는 값·타입은 lib/reportPhotoLimits.ts 에 있다.
 */
import { getAppState, setAppState } from "./appState.ts";
import { isoNow } from "./dates.ts";
import { openDb, type Db } from "./db.ts";
import { PHOTO_SLOT_COUNT, type ReportPhotoMeta } from "./reportPhotoLimits.ts";

// 목록·표시에 쓰는 정보는 화면과 공유하는 순수 모듈에 있다(그쪽 주석에 이유를 적었다).
export type { ReportPhotoMeta };

/** 실제 사진까지 담은 것. 보고서를 만들 때만 읽는다. */
export interface ReportPhoto extends ReportPhotoMeta {
  /** base64. */
  readonly data: string;
}

export interface PhotoStepState {
  readonly photos: readonly ReportPhotoMeta[];
  /** 건너뛰기를 **명시적으로** 눌렀는가. 그냥 지나친 것과 구분된다. */
  readonly skipped: boolean;
}

/** 목록·상태 확인용 조회. 큰 문자열을 괜히 끌고 오지 않는다(LIGHT_COLUMNS 와 같은 뜻). */
const META_COLUMNS = "slot, file_name, mime, bytes, saved_at";

function skipKey(month: string): string {
  return `report:photos:skipped:${month}`;
}

interface PhotoRow {
  slot: number;
  file_name: string;
  mime: string;
  bytes: number;
  saved_at: string;
  data?: string;
}

function toMeta(row: PhotoRow): ReportPhotoMeta {
  return {
    slot: Number(row.slot),
    fileName: row.file_name,
    mime: row.mime,
    bytes: Number(row.bytes),
    savedAt: row.saved_at,
  };
}

/**
 * 다른 달의 사진과 건너뜀 표시를 치운다.
 *
 * 건너뜀도 같이 치우는 이유: 사진은 없는데 "건너뜀" 만 남으면, 몇 달 뒤 그 달을 열었을 때
 * 아무것도 안 했는데 이미 정한 것처럼 보인다.
 */
async function keepOnlyMonth(db: Db, month: string): Promise<void> {
  await db.run("DELETE FROM report_photos WHERE month <> ?", [month]);
  await db.run(
    "DELETE FROM app_state WHERE key LIKE 'report:photos:skipped:%' AND key <> ?",
    [skipKey(month)],
  );
}

/** 그 달 사진의 정보만. 자리 순서대로. */
export async function listPhotos(month: string): Promise<ReportPhotoMeta[]> {
  const db = await openDb();
  try {
    const rows = (await db.all(
      `SELECT ${META_COLUMNS} FROM report_photos WHERE month = ? ORDER BY slot`,
      [month],
    )) as PhotoRow[];
    return rows.map(toMeta);
  } finally {
    await db.close();
  }
}

/** 화면이 한 번에 필요한 것 — 사진 목록과 건너뜀 여부. */
export async function loadPhotoStep(month: string): Promise<PhotoStepState> {
  const db = await openDb();
  try {
    const rows = (await db.all(
      `SELECT ${META_COLUMNS} FROM report_photos WHERE month = ? ORDER BY slot`,
      [month],
    )) as PhotoRow[];
    const flag = await getAppState(db, skipKey(month));
    return { photos: rows.map(toMeta), skipped: flag === "1" };
  } finally {
    await db.close();
  }
}

/**
 * 보고서에 넣을 사진을 실제 바이트까지 읽는다.
 *
 * 자리 번호 순으로 돌려주고, **빈 자리는 건너뛴다** — 배치는 이 배열의 순서로 정해진다
 * (lib/reportPhotoLayout.ts). 2번 자리를 지우고 3번만 남겨도 첫 자리부터 채워진다.
 */
export async function loadPhotos(month: string): Promise<ReportPhoto[]> {
  const db = await openDb();
  try {
    const rows = (await db.all(
      `SELECT ${META_COLUMNS}, data FROM report_photos WHERE month = ? ORDER BY slot`,
      [month],
    )) as PhotoRow[];
    return rows
      .slice(0, PHOTO_SLOT_COUNT)
      .map((row) => ({ ...toMeta(row), data: row.data ?? "" }));
  } finally {
    await db.close();
  }
}

/** 한 자리의 사진. 미리보기로 내려줄 때 쓴다. 없으면 null. */
export async function loadPhoto(month: string, slot: number): Promise<ReportPhoto | null> {
  const db = await openDb();
  try {
    const row = await db.get<PhotoRow>(
      `SELECT ${META_COLUMNS}, data FROM report_photos WHERE month = ? AND slot = ?`,
      [month, slot],
    );
    if (row === undefined) return null;
    return { ...toMeta(row), data: row.data ?? "" };
  } finally {
    await db.close();
  }
}

export interface SavePhoto {
  readonly month: string;
  readonly slot: number;
  readonly fileName: string;
  readonly mime: string;
  /** base64. */
  readonly data: string;
  readonly bytes: number;
}

/**
 * 한 자리를 채운다. 그 자리에 이미 있으면 갈아끼운다.
 *
 * 사진을 넣었으면 건너뜀 표시는 없어져야 한다 — 넣어 놓고 "건너뜀" 으로 보이면
 * 보고서를 만들 때 사진을 빼고 만든다.
 */
export async function savePhoto(photo: SavePhoto): Promise<void> {
  const db = await openDb();
  try {
    await db.tx(async (tx) => {
      await tx.run("DELETE FROM report_photos WHERE month = ? AND slot = ?", [
        photo.month, photo.slot,
      ]);
      await tx.run(
        `INSERT INTO report_photos (month, slot, file_name, mime, data, bytes, saved_at)
         VALUES (?,?,?,?,?,?,?)`,
        [photo.month, photo.slot, photo.fileName, photo.mime, photo.data, photo.bytes, isoNow()],
      );
    });
    await db.run("DELETE FROM app_state WHERE key = ?", [skipKey(photo.month)]);
    await keepOnlyMonth(db, photo.month);
  } finally {
    await db.close();
  }
}

/** 한 자리를 비운다. */
export async function deletePhoto(month: string, slot: number): Promise<void> {
  const db = await openDb();
  try {
    await db.run("DELETE FROM report_photos WHERE month = ? AND slot = ?", [month, slot]);
  } finally {
    await db.close();
  }
}

/**
 * 건너뛰기를 눌렀다(또는 되돌렸다).
 *
 * 건너뛰기를 누르면 이미 넣은 사진도 지운다. 안 지우면 "건너뜀" 이라 적힌 채로 사진이
 * 보고서에 들어가거나, 사진은 남았는데 보고서에는 없는 상태가 된다 — 어느 쪽이든
 * 화면과 결과물이 어긋난다.
 */
export async function setPhotosSkipped(month: string, skipped: boolean): Promise<void> {
  const db = await openDb();
  try {
    if (!skipped) {
      await db.run("DELETE FROM app_state WHERE key = ?", [skipKey(month)]);
      return;
    }
    await db.run("DELETE FROM report_photos WHERE month = ?", [month]);
    await setAppState(db, skipKey(month), "1");
    await keepOnlyMonth(db, month);
  } finally {
    await db.close();
  }
}
