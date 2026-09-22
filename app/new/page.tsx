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

      {loadError === null && combos.length === 0 && (
        <Notice tone="warn">
          <b>Product · Component 선택지가 비어 있습니다.</b>
          {" 이 목록은 이미 수집된 케이스에서 뽑습니다. 수집된 케이스가 없거나, "}
          {"케이스 상세를 아직 받지 않아 제품 정보가 비어 있을 때 이렇게 보입니다."}
        </Notice>
      )}

      <DraftForm combos={combos} />
    </>
  );
}
