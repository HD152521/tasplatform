import { requireUser } from "../../lib/appAuth.ts";
import { kbTranslationRefs } from "../../lib/kbTranslate.ts";
import {
  countKbScanned, listKbArticles, loadCaseTranslations, type KbViewRow,
} from "../../lib/queries.ts";
import { CollectButton } from "../CollectButton.tsx";
import { Card, COLOR, Notice, PageHeader, SPACE, TEXT, WEIGHT } from "../ui.tsx";
import { KbList } from "./KbList.tsx";

export const dynamic = "force-dynamic";

export default async function KbPage() {
  // 로그인한 사람만. 문을 페이지마다 두는 이유는 lib/appAuth.ts 머리말에 있다.
  await requireUser("/kb");
  let rows: KbViewRow[] = [];
  let scanned = 0;
  let loadError: string | null = null;
  // 저장된 한국어 번역. 없는 칸은 키가 없고, 목록이 원문을 그대로 쓴다.
  let translated = new Map<string, string>();

  try {
    [rows, scanned] = await Promise.all([listKbArticles(), countKbScanned()]);
    translated = await loadCaseTranslations(kbTranslationRefs(rows.map((r) => r.article_id)));
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  const match = rows.filter((r) => r.verdict === "match").length;
  const maybe = rows.filter((r) => r.verdict === "maybe").length;
  const unjudged = rows.filter((r) => r.verdict === "").length;

  return (
    <>
      <PageHeader title="기술 문서" actions={<CollectButton kind="kb" />}>
        <span style={{
          color: match > 0 ? COLOR.waitUs : COLOR.muted,
          fontWeight: match > 0 ? 500 : 400,
        }}>
          {match > 0
            ? `우리 환경과 관련 있는 문서 ${match}건 · 확인 필요 ${maybe}건`
            : `우리 제품 문서 ${rows.length}건${unjudged > 0 ? ` · 미판정 ${unjudged}건` : ""}`}
        </span>
        <span style={{ color: COLOR.faint }}>
          {`  ·  훑어본 문서 ${scanned.toLocaleString("en-US")}건  ·  출처 Broadcom Knowledge Base`}
        </span>
      </PageHeader>

      {loadError !== null && <Notice tone="error">DB를 읽지 못했습니다: {loadError}</Notice>}

      {loadError === null && rows.length === 0 && (
        <Card style={{ padding: `${SPACE.xl}px ${SPACE.xl}px`, fontSize: TEXT.base, lineHeight: 1.8 }}>
          <b>아직 수집된 문서가 없습니다.</b>
          <div style={{ color: COLOR.muted, marginTop: SPACE.sm }}>
            <code>npm run collect:kb</code>
            {" 로 최신 문서를 받아 우리 제품인지 거르고, "}
            <code>npm run judge:kb</code>
            {" 로 우리 환경에 걸리는지 판정합니다."}
          </div>
        </Card>
      )}

      {rows.length > 0 && <KbList rows={rows} translated={Object.fromEntries(translated)} />}

      {rows.length > 0 && (
        <p style={{ margin: `${SPACE.lg}px ${SPACE.xxs}px 0`, fontSize: TEXT.small, color: COLOR.faint, lineHeight: 1.75 }}>
          Broadcom 사이트맵에서 최신 문서를 받아 <b style={{ color: COLOR.muted, fontWeight: WEIGHT.semibold }}>제품 태그</b>
          {" 로 우리 제품만 남긴 목록입니다. 판정은 문서에 적힌 내용과 등록된 환경 설명을 대조한 "}
          <b style={{ color: COLOR.muted, fontWeight: WEIGHT.semibold }}>참고 의견</b>
          {" 이며, 버전이 걸리는 건은 '확인 필요' 로 둡니다. 실제 영향 여부는 원문과 SR 로 확인하세요."}
        </p>
      )}
    </>
  );
}
