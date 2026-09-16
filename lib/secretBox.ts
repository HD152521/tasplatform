/**
 * 팀 연동 자격(토큰 등) 암호화 보관함.
 *
 * AES-256-GCM. 키는 SR_SECRET_KEY 환경변수(32바이트, base64 또는 hex)에서만 읽는다.
 * 키가 없으면 평문 저장으로 폴백하지 않고 명확한 에러를 던진다 — 호출부(teamIntegration.ts)가
 * 이 에러를 그대로 올려 저장을 거부해야 한다. 여기서 절대 평문을 그대로 반환하지 않는다.
 *
 * 저장 형식: "v1:<iv-base64>:<tag-base64>:<ciphertext-base64>"
 * iv 는 매 암호화마다 새로 만든다 — GCM 은 같은 (key, iv) 조합을 재사용하면 안전성이 깨진다.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_TAG = "v1";

export class MissingSecretKeyError extends Error {
  constructor(detail?: string) {
    super(
      `SR_SECRET_KEY 환경변수가 설정되지 않았거나 올바르지 않습니다. 민감값을 암호화할 수 없어 저장을 거부합니다.` +
        ` 32바이트 키를 base64 또는 hex(64자)로 .env 의 SR_SECRET_KEY 에 넣으세요` +
        ` (생성 예: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))").` +
        (detail ? ` (${detail})` : ""),
    );
    this.name = "MissingSecretKeyError";
  }
}

function loadKey(): Buffer {
  const raw = (process.env.SR_SECRET_KEY ?? "").trim();
  if (raw === "") throw new MissingSecretKeyError("SR_SECRET_KEY 가 비어 있습니다");

  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new MissingSecretKeyError(
      `디코딩 결과가 ${key.length}바이트입니다 (32바이트 필요)`,
    );
  }
  return key;
}

/** 평문 → 암호문(직렬화 문자열). 키가 없거나 형식이 잘못되면 던진다(평문 저장 폴백 금지). */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT_TAG,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** 암호문 → 평문. 형식이 다르거나 키가 없으면(또는 변조/키 불일치) 던진다. */
export function decryptSecret(encoded: string): string {
  const key = loadKey();
  const parts = encoded.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_TAG) {
    throw new Error("암호화된 값의 형식이 올바르지 않습니다.");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64 as string, "base64");
  const tag = Buffer.from(tagB64 as string, "base64");
  const ciphertext = Buffer.from(ctB64 as string, "base64");

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/** SR_SECRET_KEY 가 유효한 형식으로 설정돼 있는지. 저장 전 화면 안내용(값 자체는 반환하지 않는다). */
export function hasSecretKey(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}
