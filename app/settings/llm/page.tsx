import { openDb } from "../../../lib/db.ts";
import { getLlmConfigMeta, type LlmConfigMeta } from "../../../lib/llmConfig.ts";
import { hasSecretKey } from "../../../lib/secretBox.ts";
import { COLOR } from "../../ui.tsx";
import { LlmSettingsForm } from "./LlmSettingsForm.tsx";

// 설정을 매 요청 읽어야 하므로 캐싱하지 않는다.
export const dynamic = "force-dynamic";

function readInitial(): { config: LlmConfigMeta | null; keyPresent: boolean } {
  const db = openDb();
  try {
    return { config: getLlmConfigMeta(db), keyPresent: hasSecretKey() };
  } finally {
    db.close();
  }
}

export default function LlmSettingsPage() {
  let config: LlmConfigMeta | null = null;
  let keyPresent = false;
  let loadError: string | null = null;

  try {
    ({ config, keyPresent } = readInitial());
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>LLM 연결</h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted }}>
          요약·리포트·답변요약이 쓰는 LLM 을 설정합니다. 비밀번호는 암호화해 저장하고 화면에는
          표시하지 않습니다. 저장 후 「연결 테스트」로 실제 호출을 확인하세요.
        </p>
      </header>

      {loadError !== null ? (
        <p style={{ color: COLOR.waitUs, fontSize: 13 }}>{`불러오지 못했습니다: ${loadError}`}</p>
      ) : (
        <LlmSettingsForm initialConfig={config} keyPresent={keyPresent} />
      )}
    </>
  );
}
