import { listCves, type CveViewRow } from "../../lib/queries.ts";
import { COLOR, Card, Notice } from "../ui.tsx";
import { CveList } from "./CveList.tsx";

export const dynamic = "force-dynamic";

export default function CvesPage() {
  let cves: CveViewRow[] = [];
  let loadError: string | null = null;

  try {
    cves = listCves();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  const critical = cves.filter((c) => c.severity === "CRITICAL").length;
  const high = cves.filter((c) => c.severity === "HIGH").length;

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          보안 공지
        </h1>
        <p style={{ margin: "7px 0 0", fontSize: 13 }}>
          <span style={{
            color: critical > 0 ? COLOR.waitUs : COLOR.muted,
            fontWeight: critical > 0 ? 500 : 400,
          }}>
            {critical > 0
              ? `Critical ${critical}건 · High ${high}건이 우리 제품에서 확인됩니다`
              : `${cves.length}건 · Critical 없음`}
          </span>
          <span style={{ color: COLOR.faint }}>{"  ·  출처 NVD"}</span>
        </p>
      </header>

      {loadError !== null && <Notice tone="error">DB를 읽지 못했습니다: {loadError}</Notice>}

      {loadError === null && cves.length === 0 && (
        <Card style={{ padding: "20px 22px", fontSize: 13.5, lineHeight: 1.8 }}>
          <b>아직 수집된 취약점이 없습니다.</b>
          <div style={{ color: COLOR.muted, marginTop: 8 }}>
            <code>npm run collect:cve</code>
            {" 를 실행하면 우리가 지원하는 제품의 최근 취약점을 가져옵니다."}
          </div>
        </Card>
      )}

      {cves.length > 0 && <CveList cves={cves} />}

      {cves.length > 0 && (
        <p style={{ margin: "16px 2px 0", fontSize: 12, color: COLOR.faint, lineHeight: 1.75 }}>
          제품명 키워드로 NVD 를 조회한 결과입니다. 키워드 매칭이라
          <b style={{ color: COLOR.muted, fontWeight: 600 }}> 우리 환경과 무관한 항목이 섞일 수 있습니다.</b>
          {" 실제 영향 여부는 Broadcom 공지나 SR 로 확인하세요."}
        </p>
      )}
    </>
  );
}
