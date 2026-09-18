import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../lib/env.ts";

function withEnvFile(content: string, run: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "srenv-"));
  const file = join(dir, ".env");
  writeFileSync(file, content, "utf8");
  try { run(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("key=value 를 읽는다", () => {
  withEnvFile("SR_TEST_A=hello\n", (f) => {
    delete process.env.SR_TEST_A;
    loadEnv(f);
    assert.equal(process.env.SR_TEST_A, "hello");
    delete process.env.SR_TEST_A;
  });
});

test("주석과 빈 줄은 무시한다", () => {
  withEnvFile("# comment\n\nSR_TEST_B=ok\n", (f) => {
    delete process.env.SR_TEST_B;
    loadEnv(f);
    assert.equal(process.env.SR_TEST_B, "ok");
    delete process.env.SR_TEST_B;
  });
});

// CONFLUENCE_PARENT_ID 가 `172097555  # "04. SR" 페이지` 로 적혀 있어 주석까지 값에
// 들어갔고, Confluence API 가 404 를 냈다.
test("줄 끝 주석을 걷어낸다", () => {
  withEnvFile(`SR_TEST_E=172097555     # "04. SR" 페이지\n`, (f) => {
    delete process.env.SR_TEST_E;
    loadEnv(f);
    assert.equal(process.env.SR_TEST_E, "172097555");
    delete process.env.SR_TEST_E;
  });
});

// 비밀번호에 # 이 들어가는 일이 있다. 공백 없이 붙은 # 은 값의 일부다.
test("공백 없이 붙은 # 은 값으로 남긴다", () => {
  withEnvFile("SR_TEST_F=ab#cd\n", (f) => {
    delete process.env.SR_TEST_F;
    loadEnv(f);
    assert.equal(process.env.SR_TEST_F, "ab#cd");
    delete process.env.SR_TEST_F;
  });
});

// 값 자체에 " #" 이 필요하면 따옴표로 감싼다. 그때는 통째로 살린다.
test("따옴표로 감싼 값은 # 이 있어도 자르지 않는다", () => {
  withEnvFile(`SR_TEST_G="a #b"\n`, (f) => {
    delete process.env.SR_TEST_G;
    loadEnv(f);
    assert.equal(process.env.SR_TEST_G, "a #b");
    delete process.env.SR_TEST_G;
  });
});

test("따옴표를 벗긴다", () => {
  withEnvFile(`SR_TEST_C="a b"\nSR_TEST_D='c d'\n`, (f) => {
    delete process.env.SR_TEST_C; delete process.env.SR_TEST_D;
    loadEnv(f);
    assert.equal(process.env.SR_TEST_C, "a b");
    assert.equal(process.env.SR_TEST_D, "c d");
    delete process.env.SR_TEST_C; delete process.env.SR_TEST_D;
  });
});

test("비밀번호에 '=' 가 있어도 온전히 읽는다", () => {
  withEnvFile("SR_TEST_E=p@ss=w0rd=\n", (f) => {
    delete process.env.SR_TEST_E;
    loadEnv(f);
    assert.equal(process.env.SR_TEST_E, "p@ss=w0rd=");
    delete process.env.SR_TEST_E;
  });
});

test("이미 설정된 환경변수는 덮어쓰지 않는다", () => {
  withEnvFile("SR_TEST_F=from_file\n", (f) => {
    process.env.SR_TEST_F = "from_shell";
    loadEnv(f);
    assert.equal(process.env.SR_TEST_F, "from_shell");
    delete process.env.SR_TEST_F;
  });
});

test("파일이 없어도 예외를 던지지 않는다", () => {
  assert.doesNotThrow(() => loadEnv(join(tmpdir(), "definitely-missing-.env")));
});
