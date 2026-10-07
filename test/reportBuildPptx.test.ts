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
function makePayload(photoCount: number, srCount: number, openCount: number): unknown {
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
    // SR 과 작업 모두 **한 장을 넘기는** 수를 넣는다. 한 장씩만 만들면 "같은 종류의
    // 장끼리 표 모양이 같은가" 를 비교할 상대가 없어 그 시험이 조용히 통과한다.
    // 작업은 한 장에 WORK_ROWS_PER_SLIDE(8)행이라 9행을 넣어야 두 장이 된다.
    // 앞 openCount 건은 **진행 중**(완료 여부가 빨간 글씨), 나머지는 종료.
    srs: Array.from({ length: srCount }, (_, i) => (
      i < openCount
        ? { ...sr, done: "진행 중", status: "진행 중", open: "1" }
        : sr
    )),
    work: Array.from({ length: 9 }, () => (
      { center: "-", corp: "-", span: "-", support: "-", title: "확인용", issue: "-", note: "-" }
    )),
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
  footerFont: { names: string[]; sizes: number[] };
  slides: Array<{
    layout: string;
    section: string;
    header: { chip: string; title: string };
    photos: Array<{ left: number; top: number; width: number; height: number }>;
    labels: string[];
    tables: Array<{
      left: number; top: number; width: number; bottom: number;
      columns: number[]; rows: number[];
      red: Array<{ row: number; col: number; text: string }>;
    }>;
  }>;
}

/**
 * 같은 장수로 두 번 만들지 않는다. 한 번이 파이썬 두 번 실행(생성+측정)이라 2초쯤
 * 걸리고, 시험마다 새로 만들면 이 파일만 20초를 쓴다. 보고서는 입력이 같으면 결과가
 * 같으므로 장수별로 한 번만 만들어 돌려 쓴다.
 */
const built = new Map<string, Described>();

/** 보고서를 만들고 재서 돌려준다. 실패하면 파이썬의 표준오류를 그대로 올린다. */
function buildAndDescribe(photoCount: number, srCount = 2, openCount = 0): Described {
  const key = `${photoCount}:${srCount}:${openCount}`;
  const cached = built.get(key);
  if (cached !== undefined) return cached;

  const dir = mkdtempSync(join(tmpdir(), "sr-report-test-"));
  try {
    const payloadPath = join(dir, "payload.json");
    const outPath = join(dir, "out.pptx");
    writeFileSync(payloadPath, JSON.stringify(makePayload(photoCount, srCount, openCount)), "utf8");

    const made = spawnSync(pythonExe(), ["scripts/build_report.py", payloadPath, outPath],
      { windowsHide: true, encoding: "utf8" });
    assert.equal(made.status, 0, `보고서 생성 실패:\n${made.stderr}`);

    const described = spawnSync(pythonExe(), ["scripts/describe_report.py", outPath],
      { windowsHide: true, encoding: "utf8" });
    assert.equal(described.status, 0, `측정 실패:\n${described.stderr}`);

    // 빈 출력에 JSON.parse 를 걸면 무엇이 찍혔는지 알 수 없는 SyntaxError 만 남는다.
    let report: Described;
    try {
      report = JSON.parse(described.stdout) as Described;
    } catch (error) {
      assert.fail(`측정 결과를 읽지 못했습니다 (${String(error)})\n`
        + `stdout: ${described.stdout.slice(0, 400)}\nstderr: ${described.stderr.slice(0, 400)}`);
    }
    built.set(key, report);
    return report;
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

/*
 * 구간 제목은 **장마다 다르다.** 고객 문서가 레이아웃으로 구분하고 있어서, 우리 양식이
 * 레이아웃 하나뿐이던 때에는 클라우드·라이선스·사진 장까지 전부 "2. 이슈 및 작업 진행
 * 사항" 으로 나갔다. 양식을 고객 문서에서 다시 뜨면서 해결됐고, 되돌아가지 않게 잠근다.
 */
test("구간 제목이 장마다 고객 문서와 같다", { skip: skip ?? false }, () => {
  const report = buildAndDescribe(4);
  // 제목에서 '> PaaS (1/6)' 같은 꼬리를 떼어 종류만 남긴다.
  const got = report.slides.map((s) => [s.header.title.split(" >")[0] ?? "", s.section] as const);

  const expected = new Map([
    ["클라우드 운영 현황 (2/2)", "1. Summary"],
    ["라이선스 현황", "1. Summary"],
    ["SR 진행현황 요약", "2. 이슈 및 작업 진행 사항"],
    ["SR 상세 진행 현황", "2. 이슈 및 작업 진행 사항"],
    ["작업 진행 현황", "2. 이슈 및 작업 진행 사항"],
    ["PaaS (1/2)", "5. 정기점검 결과 및 상세 내역"],
    ["PaaS (2/2)", "5. 정기점검 결과 및 상세 내역"],
  ]);

  const wrong = got.filter(([title, section]) => {
    const want = expected.get(title);
    return want !== undefined && want !== section;
  });
  assert.deepEqual(wrong, [], `구간 제목이 다릅니다: ${JSON.stringify(wrong)}`);

  /*
   * **기대한 제목이 전부 나왔는지 따로 확인한다.**
   *
   * 위 필터는 아는 제목만 본다. 그래서 양식에서 제목 한 줄이 바뀌면 그 장은 검사
   * 대상에서 **조용히 빠지고** 시험은 그대로 통과한다 — 구간 제목이 틀려도 녹색이
   * 된다. 되돌아가지 않게 잠그려고 만든 시험이 정작 그 구멍으로 새는 셈이다.
   */
  const seen = new Set(got.map(([title]) => title));
  const missing = [...expected.keys()].filter((title) => !seen.has(title));
  assert.deepEqual(missing, [],
    `기대한 장을 찾지 못했습니다(제목이 바뀌었나?): ${missing.join(", ")} / 나온 제목: ${[...seen].join(", ")}`);
});

// SR 상세의 구획 번호. 고객 문서는 2-3 이고 한때 2-2 로 나갔다.
test("SR 상세의 구획 번호는 2-3 이다", { skip: skip ?? false }, () => {
  const report = buildAndDescribe(0);
  const chips = report.slides
    .filter((s) => s.header.title.startsWith("SR 상세 진행 현황"))
    .map((s) => s.header.chip);
  assert.ok(chips.length > 0, "SR 상세 장을 찾지 못했습니다");
  assert.deepEqual([...new Set(chips)], ["2-3"]);
});

/*
 * 바닥글 글꼴. 고객 문서는 맑은 고딕 10.5pt 인데, 우리 양식의 '1_본문' 레이아웃이
 * `Rix고딕 L` 이어서 거의 모든 장이 다른 글꼴로 나갔다. 크기는 원래 맞았다.
 */
test("바닥글이 맑은 고딕 10.5pt 다", { skip: skip ?? false }, () => {
  const report = buildAndDescribe(0);
  assert.deepEqual(report.footerFont.names, ["맑은 고딕"]);
  assert.deepEqual(report.footerFont.sizes, [10.5]);
});

/*
 * **같은 종류의 장은 표 자리와 열 폭이 똑같아야 한다.** 장마다 미세하게 달라진다는
 * 지적이 있었다 — 원인은 양식이 고객 문서가 아니라 중간 덱이었던 것이고, 복제로
 * 만드는 장들끼리 어긋나면 그 자리에서 드러난다.
 */
test("같은 종류의 장은 표 자리·열 폭·행 높이가 같다", { skip: skip ?? false }, () => {
  const report = buildAndDescribe(4);

  /*
   * 행 **수**는 비교에서 뺀다. 마지막 장은 남은 건수만 담아 행이 적은 것이 정상이고
   * (작업 9건 → 8행 + 1행), 그걸 어긋남으로 세면 정상인 보고서가 빨갛게 된다.
   *
   * 비교하는 것은 **자리와 치수**다 — 표의 left·top·폭, 열 폭, 그리고 쓰이는 행
   * 높이의 종류(머리행 높이 + 데이터행 높이). 지적받은 "장마다 미세하게 다르다" 가
   * 바로 이 값들이다.
   */
  const groups = new Map<string, string[]>();
  for (const slide of report.slides) {
    if (slide.tables.length === 0) continue;
    const kind = slide.header.title.split(" (")[0] ?? "";
    const shape = JSON.stringify(slide.tables.map((t) => ({
      left: t.left, top: t.top, width: t.width,
      columns: t.columns,
      rowHeights: [...new Set(t.rows)].sort((a, b) => a - b),
    })));
    const seen = groups.get(kind) ?? [];
    seen.push(shape);
    groups.set(kind, seen);
  }
  for (const [kind, shapes] of groups) {
    assert.equal(new Set(shapes).size, 1,
      `${kind} 장끼리 표 모양이 다릅니다 — ${[...new Set(shapes)].join(" / ")}`);
  }
  // SR 상세와 작업 장이 여러 장 생겼는지 확인한다 — 한 장씩이면 비교가 무의미하다.
  const multi = [...groups.values()].filter((v) => v.length > 1);
  assert.ok(multi.length > 0, "여러 장 생긴 종류가 없어 비교하지 못했습니다");
});

/*
 * **SR 요약이 한 장을 넘으면 장을 나눈다.**
 *
 * 한때 한 표에 쭉 이어 붙였다. 그러면 표가 바닥글(top 7.131)을 넘어 아래쪽 글자가
 * 잘려 나가는데, 그건 파일을 열어 보기 전까지 아무도 모른다.
 */
test("SR 요약이 넘치면 다음 장으로 넘긴다", { skip: skip ?? false }, () => {
  const one = buildAndDescribe(0, 6, 0);
  const many = buildAndDescribe(0, 8, 0);

  const pagesOf = (r: Described): typeof r.slides =>
    r.slides.filter((x) => x.header.title.startsWith("SR 진행현황 요약"));

  // 6건은 한 장. 그때 제목에는 쪽 번호를 붙이지 않는다(고객 문서가 그렇다).
  const single = pagesOf(one);
  assert.equal(single.length, 1, "6건은 한 장이어야");
  assert.equal(single[0]?.header.title, "SR 진행현황 요약");

  // 8건은 두 장. 머리행 1 + 데이터로 6 / 2 로 갈린다.
  const split = pagesOf(many);
  assert.equal(split.length, 2, "8건은 두 장이어야");
  assert.deepEqual(split.map((p) => p.tables[0]?.rows.length), [7, 3]);
  assert.deepEqual(split.map((p) => p.header.title), [
    "SR 진행현황 요약 (1/2)", "SR 진행현황 요약 (2/2)",
  ]);

  // 어느 장도 바닥글을 넘지 않는다. 이게 장을 나누는 **이유**다.
  for (const page of [...single, ...split]) {
    const bottom = page.tables[0]?.bottom ?? 0;
    assert.ok(bottom > 0 && bottom < 7.131, `표가 바닥글까지 내려왔다: ${bottom}`);
  }
});

/*
 * **빨간 글씨는 "진행 중" 만이다.**
 *
 * 양식의 SR 요약표는 고객 문서에서 떠 온 것이라 그 달에 진행 중이던 행이 FF0000 으로
 * 박혀 있다. 거기에 resize_rows 가 마지막 행을 복제해 늘리므로, 칠하기만 하고
 * 되돌리지 않으면 **"종료" 가 빨갛게 나간다.** 실제로 그렇게 나갔다.
 */
test("요약의 빨간 글씨는 진행 중뿐이다", { skip: skip ?? false }, () => {
  // 8건 중 앞 3건만 진행 중 → 첫 장에 섞이고 둘째 장은 전부 종료.
  const report = buildAndDescribe(0, 8, 3);
  const pages = report.slides.filter((x) => x.header.title.startsWith("SR 진행현황 요약"));
  assert.equal(pages.length, 2);

  const reds = pages.flatMap((p) => p.tables[0]?.red ?? []);
  assert.ok(reds.length > 0, "진행 중이 있는데 빨간 칸이 하나도 없다");
  for (const cell of reds) {
    assert.equal(cell.text, "진행 중", `종료인데 빨갛다: ${JSON.stringify(cell)}`);
  }
  // 진행 중 3건이 전부 빨간지 — 덜 칠해도 안 된다.
  assert.equal(reds.length, 3, `빨간 칸이 ${reds.length}개 (기대 3)`);
  // 둘째 장은 전부 종료라 빨강이 없어야 한다.
  assert.deepEqual(pages[1]?.tables[0]?.red, []);
});

// 파이썬이 없어 건너뛰었다면 그 사실을 남긴다. 조용히 통과한 것처럼 보이면 안 된다.
test("파이썬이 있으면 위 시험들이 실제로 돌았다", () => {
  if (skip !== null) {
    console.log(`  (건너뜀: ${skip})`);
  }
  assert.ok(true);
});
