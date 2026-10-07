/**
 * SQL 별칭이 Postgres 에서도 그 이름으로 돌아오는지.
 *
 * ## 왜 이런 시험이 필요한가
 *
 * **Postgres 는 따옴표 없는 식별자를 소문자로 접는다.** `AS productName` 은
 * `productname` 이 되어, `row.productName` 이 `undefined` 가 된다. SQLite 는 별칭을
 * 적은 대로 돌려주므로 **로컬에서는 멀쩡하고 운영에서만 터진다.**
 *
 * 실제로 그렇게 나갔다. SR 작성 화면의 Product · Component 선택지가 비고, 간단히
 * 올리기는 `Cannot read properties of undefined (reading 'localeCompare')` 로 500 이
 * 됐다. 로컬 SQLite 로는 재현되지 않아 원인을 찾는 데 배포를 여러 번 썼다.
 *
 * 테스트 DB 가 SQLite 라 **값으로는 이 차이를 잡을 수 없다.** 그래서 소스에서 막는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** 따옴표 없는 camelCase 별칭. `AS productName` 은 걸리고 `AS "productId"` 는 안 걸린다. */
const BAD_ALIAS = /\bAS\s+([a-z_]+[A-Z][A-Za-z_]*)/g;

/** SQL 이 들어 있는 디렉터리. */
const DIRS = ["lib", "app", "collector", "mcp", "scripts"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** 주석 줄. 이 규칙을 **설명하는 문장** 자체가 걸리는 것을 막는다. */
const COMMENT = /^\s*(\/\/|\/\*|\*)/;

/*
 * 소스를 훑어 따옴표 없는 camelCase 별칭을 찾는다.
 *
 * SQL 문자열만 정확히 골라내지는 않는다 — 평범한 영어 문장에 걸릴 수도 있다. 그때는
 * 따옴표를 붙이거나 표현을 바꾸면 되므로 **거짓 경보를 감수하는 편**이 운영에서만
 * 터지는 버그를 놓치는 것보다 낫다. 주석만 예외로 둔다.
 */
test("따옴표 없는 camelCase SQL 별칭이 없다", () => {
  const offenders: string[] = [];
  for (const dir of DIRS) {
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      for (const [index, line] of lines.entries()) {
        if (COMMENT.test(line)) continue;
        for (const match of line.matchAll(BAD_ALIAS)) {
          offenders.push(`${file}:${index + 1} → AS ${match[1]} (따옴표 필요)`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    `Postgres 는 따옴표 없는 식별자를 소문자로 접는다. AS "camelCase" 로 바꿀 것:\n  `
    + offenders.join("\n  "));
});

// 지금 쓰는 유일한 camelCase 별칭이 실제로 따옴표를 두르고 있는지 직접 본다.
test("listProductComponents 의 별칭은 따옴표를 두른다", () => {
  const source = readFileSync("lib/queries.ts", "utf8");
  for (const alias of ["productId", "productName", "componentId", "componentName"]) {
    assert.ok(source.includes(`AS "${alias}"`), `AS "${alias}" 가 없다`);
  }
});
