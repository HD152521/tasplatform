/**
 * 사진 저장 — 월 단위 교체와 "건너뜀" 구분.
 *
 * 잠그는 성질 둘.
 *
 *   1. **"아직 안 정했다" 와 "건너뛰기를 눌렀다" 가 달라야 한다.** 같아 보이면 보고서를
 *      만들 때 사진을 잊은 사람에게 아무것도 묻지 못한다.
 *   2. **다른 달 사진은 남지 않아야 한다.** 장당 4MB 씩 넉 장이라 달마다 쌓이면 DB 가
 *      사진 보관소가 된다.
 *
 * 사진 바이트는 이 계층에서 뜻이 없어서 아무 문자열이나 쓴다. 형식 판정은
 * test/reportPhotoLimits.test.ts 가 본다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deletePhoto,
  listPhotos,
  loadPhoto,
  loadPhotos,
  loadPhotoStep,
  savePhoto,
  setPhotosSkipped,
} from "../lib/reportPhotos.ts";

/**
 * 이 모듈은 openDb() 를 스스로 부르므로 파일을 인자로 넘길 수 없다.
 * SR_DB_FILE 로 빈 임시 DB 를 가리키고 끝나면 되돌린다.
 */
async function withDb(run: () => Promise<void>): Promise<void> {
  const saved = process.env.SR_DB_FILE;
  const dir = mkdtempSync(join(tmpdir(), "srphoto-"));
  process.env.SR_DB_FILE = join(dir, "sr.db");
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.SR_DB_FILE;
    else process.env.SR_DB_FILE = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

function photo(month: string, slot: number, data = "AAAA") {
  return {
    month,
    slot,
    fileName: `photo${slot}.jpg`,
    mime: "image/jpeg",
    data,
    bytes: data.length,
  };
}

test("아무것도 안 하면 사진 0장 · 건너뜀 아님", async () => {
  await withDb(async () => {
    const state = await loadPhotoStep("2026-08");
    assert.deepEqual(state.photos, []);
    assert.equal(state.skipped, false);
  });
});

test("넣은 사진을 자리 순서대로 읽는다", async () => {
  await withDb(async () => {
    await savePhoto(photo("2026-08", 3, "Mw=="));
    await savePhoto(photo("2026-08", 1, "MQ=="));
    const slots = (await listPhotos("2026-08")).map((p) => p.slot);
    assert.deepEqual(slots, [1, 3]);
  });
});

// 같은 자리에 또 넣으면 두 장이 되는 게 아니라 갈아끼워진다.
test("같은 자리에 다시 넣으면 그 자리 것을 바꾼다", async () => {
  await withDb(async () => {
    await savePhoto(photo("2026-08", 2, "MQ=="));
    await savePhoto({ ...photo("2026-08", 2, "Mg=="), fileName: "new.jpg" });
    const photos = await loadPhotos("2026-08");
    assert.equal(photos.length, 1);
    assert.equal(photos[0]?.data, "Mg==");
    assert.equal(photos[0]?.fileName, "new.jpg");
  });
});

// 배치는 loadPhotos 가 돌려주는 **순서**로 정해진다. 중간이 비어도 앞에서부터 채워진다.
test("중간 자리를 비워도 순서는 유지되고 빈 자리는 끼지 않는다", async () => {
  await withDb(async () => {
    for (const slot of [1, 2, 3, 4]) await savePhoto(photo("2026-08", slot, `${slot}${slot}==`));
    await deletePhoto("2026-08", 2);
    const photos = await loadPhotos("2026-08");
    assert.deepEqual(photos.map((p) => p.slot), [1, 3, 4]);
    assert.equal(photos.length, 3);
  });
});

test("한 자리만 따로 읽는다. 없으면 null 이다", async () => {
  await withDb(async () => {
    await savePhoto(photo("2026-08", 1, "MQ=="));
    const one = await loadPhoto("2026-08", 1);
    assert.equal(one?.data, "MQ==");
    assert.equal(one?.mime, "image/jpeg");
    assert.equal(await loadPhoto("2026-08", 2), null);
    assert.equal(await loadPhoto("2026-07", 1), null);
  });
});

// 성질 1 — 건너뜀은 명시적으로 저장된다.
test("건너뛰기를 누르면 그 달만 건너뜀으로 남는다", async () => {
  await withDb(async () => {
    await setPhotosSkipped("2026-08", true);
    assert.equal((await loadPhotoStep("2026-08")).skipped, true);
    assert.equal((await loadPhotoStep("2026-09")).skipped, false);
  });
});

test("건너뛰기를 되돌리면 다시 '안 정함' 이 된다", async () => {
  await withDb(async () => {
    await setPhotosSkipped("2026-08", true);
    await setPhotosSkipped("2026-08", false);
    const state = await loadPhotoStep("2026-08");
    assert.equal(state.skipped, false);
    assert.deepEqual(state.photos, []);
  });
});

// 건너뛰면서 사진을 남겨 두면 "건너뜀" 이라 적힌 채 사진이 보고서에 들어간다.
test("건너뛰기를 누르면 넣어 둔 사진도 없어진다", async () => {
  await withDb(async () => {
    await savePhoto(photo("2026-08", 1));
    await setPhotosSkipped("2026-08", true);
    const state = await loadPhotoStep("2026-08");
    assert.deepEqual(state.photos, []);
    assert.equal(state.skipped, true);
  });
});

// 반대 방향 — 사진을 넣었으면 "건너뜀" 은 사라져야 한다.
test("사진을 넣으면 건너뜀 표시가 풀린다", async () => {
  await withDb(async () => {
    await setPhotosSkipped("2026-08", true);
    await savePhoto(photo("2026-08", 1));
    const state = await loadPhotoStep("2026-08");
    assert.equal(state.skipped, false);
    assert.equal(state.photos.length, 1);
  });
});

// 성질 2 — 달마다 쌓이지 않는다.
test("새 달에 사진을 넣으면 지난달 사진이 치워진다", async () => {
  await withDb(async () => {
    await savePhoto(photo("2026-07", 1, "NA=="));
    await savePhoto(photo("2026-07", 2, "NQ=="));
    assert.equal((await listPhotos("2026-07")).length, 2);

    await savePhoto(photo("2026-08", 1, "Ng=="));
    assert.deepEqual(await listPhotos("2026-07"), []);
    assert.equal((await listPhotos("2026-08")).length, 1);
  });
});

// 사진이 없는데 "건너뜀" 만 남으면, 몇 달 뒤 그 달을 열었을 때 이미 정한 것처럼 보인다.
test("새 달을 건너뛰면 지난달 건너뜀 표시도 치워진다", async () => {
  await withDb(async () => {
    await setPhotosSkipped("2026-07", true);
    await setPhotosSkipped("2026-08", true);
    assert.equal((await loadPhotoStep("2026-07")).skipped, false);
    assert.equal((await loadPhotoStep("2026-08")).skipped, true);
  });
});

test("자리 수보다 많이 들어가 있어도 보고서에는 4장까지만 나간다", async () => {
  await withDb(async () => {
    for (const slot of [1, 2, 3, 4]) await savePhoto(photo("2026-08", slot));
    assert.equal((await loadPhotos("2026-08")).length, 4);
  });
});

test("사진 바이트가 그대로 돌아온다", async () => {
  await withDb(async () => {
    // base64 로 넣은 것이 중간에 잘리거나 변형되면 python-pptx 가 열지 못한다.
    const long = Buffer.alloc(200_000, 7).toString("base64");
    await savePhoto(photo("2026-08", 1, long));
    assert.equal((await loadPhotos("2026-08"))[0]?.data, long);
  });
});
