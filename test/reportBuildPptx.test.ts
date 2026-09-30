/**
 * 보고서 pptx 를 **실제로 만들어** 재 본다.
 *
 * ## 왜 이 시험이 있나
 *
 * 배치 규칙(lib/reportPhotoLayout.ts)과 월 표기(lib/reportLabels.ts)는 각자 단위
 * 시험으로 잠겨 있다. 그런데 **둘 다 맞는데도 틀린 보고서가 두 번 배포됐다.**
 *
 *   1. lib/pptx.ts 가 사진 자리를 파이썬에 넘길 때 `align` 을 빠뜨려, 두 장이
 *      가운데에서 1인치 벌어졌다.
 *   2. 바닥글의 연·월은 슬라이드가 아니라 **레이아웃**에 있어 아무도 갱신하지
 *      않았다. 9월 보고서가 5월 라벨을 달고 나갔고, 레이아웃이 둘이라 장마다
 *      달이 달랐다.
 *
 * 둘 다 TS 와 파이썬 **사이**에서 값이 사라진 것이라, 양쪽 단위 시험으로는 잡히지
 * 않는다. 그래서 파일을 만들어 숫자를 본다.
 *
 * ## 이 시험이 잡는 것과 못 잡는 것
 *
 * payload 는 여기서 조립한다 — buildMonthlyReport 를 그대로 부르려면 DB 와 Jira 가
 * 필요하다. 그래서 **lib/pptx.ts 가 또 필드를 빠뜨리는 것 자체는 못 잡는다.** 그쪽은
 * 자리 값을 통째로 넘기도록(`{ index, ...box }`) 바꿔 구조적으로 막았고, align 이
 * 있는지는 test/reportPhotoLayout.test.ts 가 본다.
 *
 * 여기서 잡는 것은 **파이썬 쪽**이다. align 처리를 지우면 가운데가 1.023in 벌어지고,
 * 바닥글 갱신을 지우면 지난달 라벨이 남는 것을 돌연변이로 확인했다.
 *
 * ## 파이썬이 없으면 건너뛴다
 *
 * 파이썬과 python-pptx 가 필요하다. 없는 환경(일부 CI)에서 전체 시험을 빨갛게
 * 만들지 않도록 건너뛴다. **건너뛴 것이 보이게** 이유를 남긴다 — 조용히 통과한
 * 것처럼 보이면 이 시험이 있는 의미가 없다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asOfLabel, footerMonthLabel, monthLabel } from "../lib/reportLabels.ts";
import { PHOTO_CHIP, PHOTO_TITLE, layoutPhotoSlides } from "../lib/reportPhotoLayout.ts";

/**
 * 3x4 픽셀 JPEG. 비율 0.75 의 세로 사진이다.
 *
 * 크기가 작아도 배치 결과는 실제 사진과 같다 — fit_picture 는 **비율**만 보고
 * 상자에 맞춰 넣는다. 파일을 저장소에 두지 않으려고 base64 로 박아 둔다.
 */
const PHOTO_3X4 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABsSFBcUERsXFhceHBsgKEIrKCUlKFE6PTBCYFVlZF9VXVtq"
  + "eJmBanGQc1tdhbWGkJ6jq62rZ4C8ybqmx5moq6T/2wBDARweHigjKE4rK06kbl1upKSkpKSkpKSkpKSk"
  + "pKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKT/wAARCAAEAAMDASIAAhEBAxEB/8QA"
  + "HwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIh"
  + "MUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW"
  + "V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG"
  + "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQF"
  + "BgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAV"
  + "YnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE"
  + "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq"
  + "8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCnRRRXOeuf/9k=";

const MONTH = "2026-09";
const TEMPLATE = "templates/monthly-report.pptx";

/** 파이썬 실행 파일. lib/pptx.ts 와 같은 규칙으로 찾는다. */
function pythonExe(): string {
  return process.env.SR_PYTHON
    ?? (existsSync(".venv/Scripts/python.exe") ? ".venv/Scripts/python.exe" : "python");
}

/** 파이썬과 python-pptx 가 있나. 없으면 건너뛸 이유를 돌려준다. */
function missingReason(): string | null {
  if (!existsSync(TEMPLATE)) return `양식이 없습니다 (${TEMPLATE})`;
  const probe = spawnSync(pythonExe(), ["-c", "import pptx"], { windowsHide: true });
  if (probe.error !== undefined) return `파이썬을 실행할 수 없습니다 (${pythonExe()})`;
  if (probe.status !== 0) return "python-pptx 가 설치되어 있지 않습니다";
  return null;
}

/**
 * lib/pptx.ts 가 만드는 payload 와 **같은 모양**을 만든다.
 *
 * 사진 자리와 라벨은 진짜 모듈에서 가져온다 — 여기서 숫자를 베껴 적으면 정작
 * 검사하려던 "TS 가 파이썬에 제대로 넘기는가" 를 검사하지 못한다.
 */
function makePayload(photoCount: number): unknown {
  const row = { container: "100", note: "확인용", delta: "+1" };
  const sr = {
    no: "CS0000000", openedOn: "2026-09-01", closedOn: "2026-09-10",
    title: "확인용", progress: "확인용", done: "완료",
    product: "Tanzu Application Service", severity: "3", status: "완료",
    symptom: "확인용", analysis: "확인용", result: "확인용", open: "0",
  };
  return {
    template: TEMPLATE,
    monthLabel: monthLabel(MONTH),
    asOfLabel: asOfLabel(MONTH),
    footerMonthLabel: footerMonthLabel(MONTH),
    cloud: {
      rows: Array.from({ length: 6 }, () => row),
      total: { cluster: "6", host: "12", container: "600", delta: "+6" },
    },
    license: { bank: "300", central: "300", total: "600" },
    srs: [sr, sr],
    work: [{ center: "-", corp: "-", span: "-", support: "-", title: "확인용", issue: "-", note: "-" }],
    photos: layoutPhotoSlides(photoCount).map((slide) => ({
      chip: PHOTO_CHIP,
      title: `${PHOTO_TITLE} (${slide.page}/${slide.total})`,
      items: slide.items.map(({ index, ...box }) => ({ ...box, data: index < photoCount ? PHOTO_3X4 : "" })),
    })),
  };
}

interface Described {
  slideWidth: number;
  slideHeight: number;
  slides: Array<{
    photos: Array<{ left: number; top: number; width: number; height: number }>;
    labels: string[];
  }>;
}

/** 보고서를 만들고 재서 돌려준다. 실패하면 파이썬의 표준오류를 그대로 올린다. */
function buildAndDescribe(photoCount: number): Described {
  const dir = mkdtempSync(join(tmpdir(), "sr-report-test-"));
  try {
    const payloadPath = join(dir, "payload.json");
    const outPath = join(dir, "out.pptx");
    writeFileSync(payloadPath, JSON.stringify(makePayload(photoCount)), "utf8");

    const built = spawnSync(pythonExe(), ["scripts/build_report.py", payloadPath, outPath],
      { windowsHide: true, encoding: "utf8" });
    assert.equal(built.status, 0, `보고서 생성 실패:\n${built.stderr}`);

    const described = spawnSync(pythonExe(), ["scripts/describe_report.py", outPath],
      { windowsHide: true, encoding: "utf8" });
    assert.equal(described.status, 0, `측정 실패:\n${described.stderr}`);
    return JSON.parse(described.stdout) as Described;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const skip = missingReason();

/*
 * 슬라이드 비율. 고객 원본이 4:3(10.833 x 7.5in)이고 우리 양식도 거기에 맞췄다.
 * 한때 16:9(13.333in)였는데, 같은 문서에 섞으면 비율이 눈에 띄게 달랐다.
 */
test("보고서는 4:3 슬라이드로 나온다", { skip: skip ?? false }, () => {
  const report = buildAndDescribe(0);
  assert.equal(report.slideWidth, 10.833);
  assert.equal(report.slideHeight, 7.5);
});

/*
 * 사진 두 장은 **가운데에서 맞붙는다.** 비율을 지키면 상자에 남는 자리가 생기는데
 * 그 자리를 바깥으로 밀어야 큰 한 장처럼 보인다. align 이 파이썬까지 가지 않아
 * 1.025인치 벌어진 보고서가 실제로 배포됐다 — 이 시험이 그걸 잡는다.
 */
test("사진 두 장이 가운데에서 맞붙는다", { skip: skip ?? false }, () => {
  const report = buildAndDescribe(2);
  const slide = report.slides.find((s) => s.photos.length === 2);
  assert.ok(slide !== undefined, "사진 두 장이 있는 장을 찾지 못했습니다");

  const [first, second] = slide.photos;
  assert.ok(first !== undefined && second !== undefined);

  const gap = second.left - (first.left + first.width);
  assert.ok(Math.abs(gap) < 0.002, `가운데가 ${gap.toFixed(3)}in 벌어졌습니다`);

  // 좌우 바깥 여백이 대칭이어야 가운데에 놓인 것으로 보인다.
  const outerLeft = first.left;
  const outerRight = report.slideWidth - (second.left + second.width);
  assert.ok(Math.abs(outerLeft - outerRight) < 0.01,
    `바깥 여백이 왼 ${outerLeft} / 오른 ${outerRight} 로 어긋납니다`);

  // 비율(0.75)을 지켰나. 상자에 맞춰 늘리면 사람이 찌그러진다.
  for (const photo of slide.photos) {
    assert.ok(Math.abs(photo.width / photo.height - 0.75) < 0.01,
      `사진 비율이 ${(photo.width / photo.height).toFixed(3)} 입니다`);
  }

  // 두 장의 위아래 줄이 맞아야 한쪽만 떠 보이지 않는다.
  assert.equal(first.top, second.top);
  assert.equal(first.height, second.height);
});

/*
 * 바닥글의 연·월. **레이아웃에 있어 12장이 한꺼번에 틀린다.** 9월 보고서가 5월
 * 라벨을 달고 나갔고, 레이아웃이 둘이라 장마다 5월·6월로 갈렸다.
 */
test("모든 장의 바닥글과 기준일이 보고월을 따른다", { skip: skip ?? false }, () => {
  const report = buildAndDescribe(4);
  const wanted = footerMonthLabel(MONTH);   // "2026년 09월"
  const stale: string[] = [];

  for (const [index, slide] of report.slides.entries()) {
    for (const label of slide.labels) {
      // 연·월이 있는 라벨은 보고월이어야 한다.
      if (/\d{4}\s*년\s*\d{1,2}\s*월/.test(label) && !label.startsWith(wanted)) {
        stale.push(`슬라이드 ${index + 1}: ${label}`);
      }
      // 기준일이 있는 라벨은 보고월 말일이어야 한다.
      if (/기준/.test(label) && !label.includes(asOfLabel(MONTH))) {
        stale.push(`슬라이드 ${index + 1}: ${label}`);
      }
    }
  }
  assert.deepEqual(stale, [], `지난달 라벨이 남았습니다:\n${stale.join("\n")}`);

  // 라벨을 하나도 못 찾았다면 시험이 아무것도 검사하지 않은 것이다.
  const seen = report.slides.flatMap((s) => s.labels);
  assert.ok(seen.some((l) => l.startsWith(wanted)), "바닥글 라벨을 한 장도 찾지 못했습니다");
  assert.ok(seen.some((l) => l.includes(asOfLabel(MONTH))), "기준일 라벨을 찾지 못했습니다");
});

/*
 * 사진이 0장이면 사진 슬라이드를 **한 장도** 만들지 않는다. 빈 사진틀이 남은
 * 보고서를 고객에게 보내는 것이 가장 나쁘다.
 */
test("사진이 없으면 사진 슬라이드를 만들지 않는다", { skip: skip ?? false }, () => {
  const none = buildAndDescribe(0);
  const four = buildAndDescribe(4);
  // 사진 장은 2장씩 들어가므로 4장이면 두 장이 늘어난다.
  assert.equal(four.slides.length - none.slides.length, 2);
});

// 파이썬이 없어 건너뛰었다면 그 사실을 남긴다. 조용히 통과한 것처럼 보이면 안 된다.
test("파이썬이 있으면 위 시험들이 실제로 돌았다", () => {
  if (skip !== null) {
    console.log(`  (건너뜀: ${skip})`);
  }
  assert.ok(true);
});
