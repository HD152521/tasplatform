import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MissingSecretKeyError, decryptSecret, encryptSecret, hasSecretKey } from "../lib/secretBox.ts";

/** SR_SECRET_KEY 를 테스트 동안만 바꾸고 원래 값으로 되돌린다. */
function withKey<T>(key: string | undefined, fn: () => T): T {
  const prev = process.env.SR_SECRET_KEY;
  if (key === undefined) delete process.env.SR_SECRET_KEY;
  else process.env.SR_SECRET_KEY = key;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SR_SECRET_KEY;
    else process.env.SR_SECRET_KEY = prev;
  }
}

const SAMPLE_KEY_B64 = randomBytes(32).toString("base64");
const SAMPLE_KEY_HEX = randomBytes(32).toString("hex");

test("암호화한 값을 같은 키로 복호화하면 원문과 같다 (base64 키)", () => {
  withKey(SAMPLE_KEY_B64, () => {
    const enc = encryptSecret("my-secret-token-1234");
    assert.equal(decryptSecret(enc), "my-secret-token-1234");
  });
});

test("암호화한 값을 같은 키로 복호화하면 원문과 같다 (hex 키)", () => {
  withKey(SAMPLE_KEY_HEX, () => {
    const enc = encryptSecret("another-token");
    assert.equal(decryptSecret(enc), "another-token");
  });
});

test("빈 문자열도 왕복한다", () => {
  withKey(SAMPLE_KEY_B64, () => {
    const enc = encryptSecret("");
    assert.equal(decryptSecret(enc), "");
  });
});

test("유니코드·특수문자도 왕복한다", () => {
  withKey(SAMPLE_KEY_B64, () => {
    const original = "한글 토큰 🔑 !@#$%^&*()_+{}:\"<>?";
    const enc = encryptSecret(original);
    assert.equal(decryptSecret(enc), original);
  });
});

test("암호화할 때마다 iv 가 달라 같은 평문도 암호문이 달라진다", () => {
  withKey(SAMPLE_KEY_B64, () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a), "same-value");
    assert.equal(decryptSecret(b), "same-value");
  });
});

test("암호문에는 평문이 부분 문자열로도 섞이지 않는다", () => {
  withKey(SAMPLE_KEY_B64, () => {
    const enc = encryptSecret("super-secret-value-xyz");
    assert.ok(!enc.includes("super-secret-value-xyz"));
  });
});

test("SR_SECRET_KEY 가 없으면 암호화를 거부한다 (평문 저장 폴백 금지)", () => {
  withKey(undefined, () => {
    assert.throws(() => encryptSecret("token"), MissingSecretKeyError);
  });
});

test("SR_SECRET_KEY 가 없으면 복호화도 거부한다", () => {
  withKey(undefined, () => {
    assert.throws(() => decryptSecret("v1:aa:bb:cc"), MissingSecretKeyError);
  });
});

test("SR_SECRET_KEY 길이가 32바이트가 아니면 거부한다", () => {
  withKey(Buffer.from("short-key").toString("base64"), () => {
    assert.throws(() => encryptSecret("token"), MissingSecretKeyError);
  });
});

test("빈 문자열 SR_SECRET_KEY 도 없는 것과 같이 거부한다", () => {
  withKey("", () => {
    assert.throws(() => encryptSecret("token"), MissingSecretKeyError);
  });
});

test("다른 키로는 복호화할 수 없다 (변조·키 불일치 탐지)", () => {
  const enc = withKey(SAMPLE_KEY_B64, () => encryptSecret("token-value"));
  withKey(randomBytes(32).toString("base64"), () => {
    assert.throws(() => decryptSecret(enc));
  });
});

test("형식이 다른 암호문은 복호화를 거부한다", () => {
  withKey(SAMPLE_KEY_B64, () => {
    assert.throws(() => decryptSecret("not-our-format"));
    assert.throws(() => decryptSecret("v2:a:b:c"));
  });
});

test("hasSecretKey 는 키 유무를 boolean 으로 알려준다", () => {
  withKey(undefined, () => assert.equal(hasSecretKey(), false));
  withKey(SAMPLE_KEY_B64, () => assert.equal(hasSecretKey(), true));
});
