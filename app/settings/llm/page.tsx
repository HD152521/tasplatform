import { requireUser } from "../../../lib/appAuth.ts";
import { openDb } from "../../../lib/db.ts";
import {
  getLlmConfigMeta,
  listLlmConnections,
  type LlmConfigMeta,
  type LlmConnectionSummary,
} from "../../../lib/llmConfig.ts";
import { hasSecretKey } from "../../../lib/secretBox.ts";
import { COLOR } from "../../ui.tsx";
import { LlmSettingsForm } from "./LlmSettingsForm.tsx";

// 설정을 매 요청 읽어야 하므로 캐싱하지 않는다.
export const dynamic = "force-dynamic";

interface Initial {
  config: LlmConfigMeta | null;
  connections: LlmConnectionSummary[];
  keyPresent: boolean;
}

async function readInitial(): Promise<Initial> {
  const db = await openDb();
  try {
    return {
      config: await getLlmConfigMeta(db),
      connections: await listLlmConnections(db),
      keyPresent: hasSecretKey(),
    };
  } finally {
    await db.close();
  }
}

export default async function LlmSettingsPage() {
  // 로그인한 사람만. 문을 페이지마다 두는 이유는 lib/appAuth.ts 머리말에 있다.
  await requireUser("/settings/llm");
  let config: LlmConfigMeta | null = null;
  let connections: LlmConnectionSummary[] = [];
  let keyPresent = false;
  let loadError: string | null = null;

  try {
    ({ config, connections, keyPresent } = await readInitial());
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>LLM 연결</h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted }}>
          연결을 여러 개 등록해 두고 그중 하나를 <strong>활성</strong>으로 씁니다. 요약·번역·보고서는
          활성 연결만 호출합니다. 비밀번호는 암호화해 저장하고 화면에는 다시 표시하지 않습니다 —
          그래서 설정을 덮어쓰기보다 새 연결로 두는 편이 안전합니다. 저장 후 「연결 테스트」로
          실제 호출을 확인하세요.
        </p>
      </header>

      {loadError !== null ? (
        <p style={{ color: COLOR.waitUs, fontSize: 13 }}>{`불러오지 못했습니다: ${loadError}`}</p>
      ) : (
        <LlmSettingsForm
          initialConfig={config}
          initialConnections={connections}
          keyPresent={keyPresent}
        />
      )}
    </>
  );
}
