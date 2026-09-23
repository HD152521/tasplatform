import { PRODUCT_CATALOG } from "../../lib/productCatalog.ts";
import { listProductComponents, type ProductComponent } from "../../lib/queries.ts";
import { COLOR, Notice } from "../ui.tsx";
import { DraftForm } from "./DraftForm.tsx";

export const dynamic = "force-dynamic";

export default async function NewCasePage() {
  let combos: ProductComponent[] = [];
  // 조회 실패와 "아직 수집된 게 없음" 을 구분한다. 예전엔 둘 다 빈 목록이라
  // 선택지가 사라진 이유를 화면에서 알 수 없었다.
  let loadError: string | null = null;
  try {
    combos = await listProductComponents();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  // 수집된 케이스에서 못 뽑으면 내장 목록으로 채운다. 드롭다운이 비면 SR 을 아예 못 쓴다.
  // used 는 전부 0 이라 정렬이 안정적이고, 목록에 적어 둔 순서(많이 쓴 순)가 유지된다.
  const fromCatalog = combos.length === 0;
  if (fromCatalog) combos = PRODUCT_CATALOG.map((c) => ({ ...c, used: 0 }));


  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          SR 작성
        </h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted }}>
          한국어로 적으면 Broadcom 이 읽기 좋은 형식으로 정리해 드립니다.
        </p>
      </header>

      {loadError !== null && (
        <Notice tone="error">
          {`Product · Component 목록을 읽지 못했습니다: ${loadError}`}
        </Notice>
      )}

      <DraftForm combos={combos} fromCatalog={fromCatalog} />
    </>
  );
}
