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
