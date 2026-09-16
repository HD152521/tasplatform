import { listProductComponents, type ProductComponent } from "../../lib/queries.ts";
import { COLOR } from "../ui.tsx";
import { DraftForm } from "./DraftForm.tsx";

export const dynamic = "force-dynamic";

export default function NewCasePage() {
  let combos: ProductComponent[] = [];
  try {
    combos = listProductComponents();
  } catch {
    combos = [];
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

      <DraftForm combos={combos} />
    </>
  );
}
