/**
 * 요약 텍스트 → Confluence storage(XHTML) 변환 검증.
 *
 * ## 이 파일이 다시 쓰인 이유
 *
 * 변환기가 **아는 섹션 이름 네 개**만 헤딩으로 인식했다. 그 사이 요약 프롬프트의
 * 섹션 이름이 바뀌어 네 개가 하나도 안 맞게 됐고, 게시된 문서에 `### 문제` 가
 * **글자 그대로** 찍혔다. 불릿도 처리하지 않아 목록이 한 문단으로 뭉쳤다.
 *
 * 그래서 판별 기준을 이름에서 **모양**으로 바꿨다. 시험도 그 계약으로 다시 썼다 —
 * 이름 목록을 검사하던 옛 시험은 앞으로 프롬프트가 바뀌어도 아무것도 지켜 주지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toConfluenceStorage, escapeXml } from "../lib/confluenceStorage.ts";
import { CONFLUENCE_SECTIONS } from "../lib/summaryPrompt.ts";

/*
 * **섹션 이름을 따지지 않는다.** 이름으로 판별하면 프롬프트가 바뀔 때 조용히 깨진다.
 */
test("# 으로 시작하면 이름과 무관하게 헤딩이다", () => {
  for (const name of ["문제", "환경 및 진단 내역", "원인 분석", "해결 제안 및 조치 방안",
    "문제 정의", "아무 제목"]) {
    const out = toConfluenceStorage(`### ${name}\n\n본문`);
    assert.match(out, new RegExp(`<h2>${name}</h2>`), `${name} 이 헤딩이 아니다`);
    assert.doesNotMatch(out, /###/, `${name} 에서 # 가 남았다`);
  }
});

test("# 개수는 상관없다", () => {
  for (const hashes of ["#", "##", "###", "####"]) {
    assert.match(toConfluenceStorage(`${hashes} 제목`), /<h2>제목<\/h2>/);
  }
});

/*
 * `#` 이 없으면 헤딩이 아니다. 양식 밖의 평범한 한 줄을 제목으로 올려 버리면
 * 문서 구조가 엉킨다.
 */
test("# 이 없으면 문단이다", () => {
  const out = toConfluenceStorage("임의 제목\n\n본문");
  assert.match(out, /<p>임의 제목<\/p>/);
  assert.doesNotMatch(out, /<h2>/);
});

// `#` 뒤에 공백이 없으면 헤딩이 아니다(해시태그·번호 등).
test("# 뒤에 공백이 없으면 헤딩이 아니다", () => {
  const out = toConfluenceStorage("#1 항목은 보류");
  assert.doesNotMatch(out, /<h2>/);
  assert.match(out, /<p>#1 항목은 보류<\/p>/);
});

/*
 * 불릿은 **이어지는 동안 한 목록으로** 묶는다. 한 줄씩 문단으로 내면 Confluence 에서
 * 목록이 아니라 그냥 줄바꿈으로 보인다 — 그게 지금까지의 모습이었다.
 */
test("이어지는 불릿을 하나의 <ul> 로 묶는다", () => {
  const out = toConfluenceStorage("- 첫째\n- 둘째\n- 셋째");
  assert.equal(out, "<ul><li>첫째</li><li>둘째</li><li>셋째</li></ul>");
});

test("별표 불릿도 받는다", () => {
  assert.match(toConfluenceStorage("* 항목"), /<ul><li>항목<\/li><\/ul>/);
});

test("문단과 목록이 섞여도 각각으로 나뉜다", () => {
  const out = toConfluenceStorage("앞 문단\n- 가\n- 나\n뒤 문단");
  assert.match(out, /<p>앞 문단<\/p>/);
  assert.match(out, /<ul><li>가<\/li><li>나<\/li><\/ul>/);
  assert.match(out, /<p>뒤 문단<\/p>/);
});

// 빈 줄로 끊긴 불릿은 목록을 따로 만든다 — 원문의 묶음을 유지한다.
test("빈 줄로 끊기면 목록도 끊긴다", () => {
  const out = toConfluenceStorage("- 가\n\n- 나");
  assert.equal((out.match(/<ul>/g) ?? []).length, 2);
});

test("불릿 기호만 있고 내용이 없으면 목록이 아니다", () => {
  const out = toConfluenceStorage("-\n- ");
  assert.doesNotMatch(out, /<ul>/);
});

test("마크다운 파이프 표를 <table> 로 바꾸고 구분선은 건너뛴다", () => {
  const md = "| 구분 | 내용 |\n|---|---|\n| 환경 | TAS |";
  const out = toConfluenceStorage(md);
  assert.match(out, /<table><tbody>/);
  assert.match(out, /<th>구분<\/th><th>내용<\/th>/);
  assert.match(out, /<td>환경<\/td><td>TAS<\/td>/);
  assert.doesNotMatch(out, /---/);
});

test("XML 특수문자를 이스케이프한다", () => {
  assert.equal(escapeXml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  assert.match(toConfluenceStorage("a < b & c"), /a &lt; b &amp; c/);
  // 헤딩과 목록 안에서도 이스케이프한다 — 안 하면 storage 가 깨져 게시가 거절된다.
  assert.match(toConfluenceStorage("### a & b"), /<h2>a &amp; b<\/h2>/);
  assert.match(toConfluenceStorage("- a < b"), /<li>a &lt; b<\/li>/);
});

test("빈 입력은 빈 문자열", () => {
  assert.equal(toConfluenceStorage(""), "");
  assert.equal(toConfluenceStorage("   \n\n  "), "");
});

/*
 * **문서를 조립하는 쪽과 변환하는 쪽이 같은 서식을 보는지** 직접 확인한다.
 *
 * 이 둘이 갈라진 것이 원래 버그였다. `assembleConfluenceDoc` 는 섹션마다
 * `### ${heading}` 을 붙이는데, 변환기는 **아는 이름 네 개**만 헤딩으로 봤다.
 * 이름이 바뀌자 네 개가 하나도 안 맞아 `### 문제` 가 글자 그대로 게시됐다.
 *
 * 그래서 정본(CONFLUENCE_SECTIONS)에서 제목을 꺼내 와 실제로 변환해 본다. 섹션
 * 이름이 또 바뀌어도 이 시험은 계속 유효하다 — 이름을 적어 두지 않기 때문이다.
 */
test("문서 섹션 제목이 전부 헤딩으로 변환된다", () => {
  const headings = CONFLUENCE_SECTIONS
    .map((section) => section.heading.trim())
    .filter((heading) => heading !== "");
  assert.ok(headings.length >= 3, `섹션 제목을 못 찾았다 (${headings.length}개)`);

  for (const heading of headings) {
    // assembleConfluenceDoc 가 실제로 만드는 모양 그대로 넣는다.
    const out = toConfluenceStorage(`### ${heading}

본문`);
    assert.match(out, /<h2>/, `"${heading}" 이 헤딩으로 변환되지 않는다`);
    assert.doesNotMatch(out, /###/, `"${heading}" 에서 # 가 남았다`);
    assert.ok(out.includes(`<h2>${heading}</h2>`) || out.includes("&"),
      `"${heading}" 의 글자가 보존되지 않았다: ${out.slice(0, 80)}`);
  }
});

/*
 * ## 코드 블록
 *
 * 요약은 **진단 명령과 설정 구문을 코드 블록으로 그대로 옮기게** 되어 있다
 * (lib/summaryPrompt.ts 의 cleanSectionText 가 코드 블록 안을 일부러 건드리지 않는다).
 * 그런데 변환기에 그 규칙이 없어서 게시된 문서에 ``` 가 **글자 그대로** 찍혔다 —
 * 헤딩과 똑같은 구멍이다. 명령을 복사해 쓰려는 사람이 가장 많이 보는 자리다.
 */
test("코드 블록은 매크로가 되고 ``` 가 남지 않는다", () => {
  const out = toConfluenceStorage("```bash\nbosh -d cf ssh log-cache/0\n```");
  assert.match(out, /<ac:structured-macro ac:name="code" ac:schema-version="1">/);
  assert.match(out, /bosh -d cf ssh log-cache\/0/);
  assert.doesNotMatch(out, /```/, "울타리가 글자로 남았다");
});

test("여는 줄에 붙은 말이 언어가 된다", () => {
  assert.match(
    toConfluenceStorage("```bash\nls\n```"),
    /<ac:parameter ac:name="language">bash<\/ac:parameter>/,
  );
  // 말이 없거나 모양이 아니면 아예 붙이지 않는다. 틀린 언어보다 없는 편이 낫다.
  for (const fence of ["```", "```아무 말 두 개"]) {
    assert.doesNotMatch(
      toConfluenceStorage(`${fence}\nls\n\`\`\``),
      /ac:name="language"/,
      `${fence} 에서 언어가 붙었다`,
    );
  }
});

/*
 * 코드 블록 안의 `#`·`-`·`|` 는 주석이나 옵션일 뿐이다. 헤딩·불릿·표로 바꾸면
 * 명령이 제목으로 바뀌어 **복사해서 쓸 수 없는 글**이 된다.
 */
test("코드 블록 안은 헤딩·불릿·표로 보지 않는다", () => {
  const out = toConfluenceStorage("```sh\n# 주석\n- 옵션\n| a | b |\n```");
  assert.doesNotMatch(out, /<h2>/);
  assert.doesNotMatch(out, /<ul>/);
  assert.doesNotMatch(out, /<table>/);
  assert.match(out, /# 주석/);
});

/*
 * CDATA 라서 이스케이프하지 않는다 — `<`·`&` 가 들어간 설정 구문이 원문대로 보여야
 * 한다. 다만 CDATA 를 닫는 글자가 본문에 있으면 **문서가 그 자리에서 깨져 게시가
 * 실패한다.** 그것만 쪼갠다.
 */
test("코드 안의 특수문자는 원문대로 두고, CDATA 를 닫는 글자만 쪼갠다", () => {
  const out = toConfluenceStorage('```xml\n<a href="x">b & c</a>\n```');
  assert.match(out, /<a href="x">b & c<\/a>/, "이스케이프되면 원문이 아니다");

  const closing = toConfluenceStorage("```\na]]>b\n```");
  assert.doesNotMatch(closing, /\[CDATA\[a\]\]>b/, "CDATA 가 중간에서 닫혔다");
  assert.match(closing, /\]\]\]\]><!\[CDATA\[>/);
});

// 모델이 닫는 줄을 빠뜨리기도 한다. 여는 줄만 글자로 남기는 것보다 끝까지 코드가 낫다.
test("닫는 줄이 없으면 글 끝까지 코드로 본다", () => {
  const out = toConfluenceStorage("```bash\nls -al\n더 적은 줄");
  assert.doesNotMatch(out, /```/);
  assert.match(out, /ls -al\n더 적은 줄/);
});

/*
 * 한 줄 안의 백틱도 같은 단축어다. 문단·불릿·표 어디에 있든 코드 글씨가 되어야 한다.
 */
test("한 줄 안의 백틱은 코드 글씨가 된다", () => {
  assert.match(toConfluenceStorage("`bosh` 로 붙는다"), /<p><code>bosh<\/code> 로 붙는다<\/p>/);
  assert.match(toConfluenceStorage("- `-d` 는 값을 받는다"), /<li><code>-d<\/code> 는 값을 받는다<\/li>/);
  assert.match(toConfluenceStorage("| `a` | b |"), /<td><code>a<\/code><\/td>/);
});

// 짝이 없는 백틱 하나는 그대로 둔다. 멋대로 태그를 열면 문서가 깨진다.
test("짝 없는 백틱은 건드리지 않는다", () => {
  const out = toConfluenceStorage("백틱 하나 ` 만 있는 줄");
  assert.doesNotMatch(out, /<code>/);
  assert.match(out, /백틱 하나 ` 만 있는 줄/);
});
