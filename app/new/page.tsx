import { mergeCatalog } from "../../lib/productCatalog.ts";
import { listProductComponents, type ProductComponent } from "../../lib/queries.ts";
import { COLOR, Notice } from "../ui.tsx";
import { DraftForm } from "./DraftForm.tsx";
import { QuickButton } from "./QuickButton.tsx";

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

  // 수집분에 내장 목록을 **더한다**. 예전처럼 "비었을 때만" 쓰면, 쓸모없는 조합이
  // 몇 개만 있어도 내장 목록이 안 켜져 정작 필요한 제품을 못 골랐다.
  const fromDbCount = combos.length;
  combos = mergeCatalog(combos);


  return (
    <>
      <header style={{
        marginBottom: 20, display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", gap: 16,
      }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
            SR 작성
          </h1>
          <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted }}>
            한국어로 적으면 Broadcom 이 읽기 좋은 형식으로 정리해 드립니다.
          </p>
        </div>
        {/*
          한 칸만 적으면 Product · Component 까지 정해 주는 빠른 길. 아래 폼은 직접
          고르고 싶을 때 쓴다 — 둘 다 같은 /api/create 로 등록한다.
        */}
        <QuickButton />
      </header>

      {loadError !== null && (
        <Notice tone="error">
          {`Product · Component 목록을 읽지 못했습니다: ${loadError}`}
        </Notice>
      )}

      <DraftForm combos={combos} fromCatalog={fromDbCount === 0} />
    </>
  );
}
