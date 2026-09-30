import Link from "next/link";
import { COLOR, MONO_STACK, RADIUS } from "../ui.tsx";

/**
 * 정기점검 보고서 진행 표시.
 *
 * 단계를 URL(`?step=`)로 두는 이유는, 새로고침하거나 링크를 주고받아도
 * 같은 자리로 돌아오기 때문이다. 각 단계의 선택은 DB 에 저장된다.
 */
export const STEPS: ReadonlyArray<{ n: number; label: string; note: string }> = [
  { n: 1, label: "인스턴스 수", note: "클라우드 운영 현황" },
  { n: 2, label: "SR 선택", note: "SR 요약 · 상세" },
  { n: 3, label: "작업 내역", note: "Jira 작업 진행 현황" },
  { n: 4, label: "사진", note: "현장 사진 (건너뛰기 가능)" },
  { n: 5, label: "보고서 생성", note: "PPT 파일 내려받기" },
];

/** 사진 단계의 번호. 여기만 "지나갔다" 가 아니라 실제 상태로 표시를 정한다. */
export const PHOTO_STEP = 4;

export interface PhotoStepMark {
  /** 넣은 장수. */
  readonly count: number;
  /** 건너뛰기를 **명시적으로** 눌렀는가. */
  readonly skipped: boolean;
}

/**
 * 사진 단계는 지나갔다는 것만으로 ✓ 를 칠하지 않는다.
 *
 * 건너뛸 수 있는 단계라, 지나간 것을 전부 ✓ 로 칠하면 "건너뛴 것" 과 "한 것" 이
 * 똑같이 보인다. 그러면 보고서를 만들 때 사진을 잊은 사람에게 아무것도 묻지 못한다.
 *
 *   사진을 넣었다     ✓ (초록)
 *   건너뛰기를 눌렀다 — (회색) + "건너뜀"
 *   아직 안 정했다    숫자
 */
function photoMark(photos: PhotoStepMark): { glyph: string; tone: "done" | "skipped" | "todo" } {
  if (photos.count > 0) return { glyph: "✓", tone: "done" };
  if (photos.skipped) return { glyph: "—", tone: "skipped" };
  return { glyph: String(PHOTO_STEP), tone: "todo" };
}

export function Stepper({
  month, step, counts, photos,
}: {
  month: string;
  step: number;
  counts: { sr: number; jira: number };
  photos: PhotoStepMark;
}) {
  const photo = photoMark(photos);

  return (
    <nav style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
      {STEPS.map((s) => {
        const active = s.n === step;
        const isPhoto = s.n === PHOTO_STEP;
        const done = isPhoto ? photo.tone === "done" : s.n < step;
        const skipped = isPhoto && photo.tone === "skipped";
        const glyph = isPhoto ? photo.glyph : done ? "✓" : String(s.n);
        const picked = s.n === 2 ? counts.sr : s.n === 3 ? counts.jira
          : isPhoto ? photos.count : 0;
        const note = skipped ? "건너뜀" : s.note;
        return (
          <Link
            key={s.n}
            href={`/report?month=${month}&step=${s.n}`}
            style={{
              flex: "1 1 148px", minWidth: 0,
              display: "flex", alignItems: "center", gap: 11,
              padding: "12px 15px", textDecoration: "none",
              borderRadius: RADIUS.card,
              background: active ? COLOR.accent : COLOR.surface,
              border: `1px solid ${active ? COLOR.accent : COLOR.line}`,
            }}
          >
            <span style={{
              width: 24, height: 24, flexShrink: 0, borderRadius: RADIUS.pill,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontFamily: MONO_STACK, fontSize: 12, fontWeight: 700,
              background: active ? "rgba(255,255,255,.22)" : done ? COLOR.okBg : COLOR.ground,
              color: active ? "#ffffff" : done ? COLOR.ok : COLOR.faint,
            }}>
              {glyph}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{
                display: "block", fontSize: 13, fontWeight: 600,
                color: active ? "#ffffff" : COLOR.ink,
              }}>
                {s.label}
                {picked > 0 && (
                  <span style={{
                    marginLeft: 6, fontFamily: MONO_STACK, fontSize: 11, fontWeight: 400,
                    color: active ? "rgba(255,255,255,.75)" : COLOR.muted,
                  }}>
                    {picked}
                  </span>
                )}
              </span>
              <span style={{
                display: "block", fontSize: 11, marginTop: 2,
                color: active ? "rgba(255,255,255,.7)" : COLOR.faint,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {note}
              </span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/** 단계 아래에 붙는 이전/다음. 마지막 단계에서는 다음 대신 안내를 보여준다. */
export function StepNav({ month, step }: { month: string; step: number }) {
  const linkStyle = {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "10px 18px", fontSize: 13.5, fontWeight: 600,
    borderRadius: RADIUS.control, textDecoration: "none",
  } as const;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      marginTop: 18, paddingTop: 16, borderTop: `1px solid ${COLOR.divider}`,
    }}>
      {step > 1 ? (
        <Link href={`/report?month=${month}&step=${step - 1}`} style={{
          ...linkStyle, color: COLOR.body,
          background: COLOR.surface, border: `1px solid ${COLOR.field}`,
        }}>
          ← 이전
        </Link>
      ) : <span />}

      <span style={{ marginLeft: "auto" }} />

      {step < STEPS.length ? (
        <Link href={`/report?month=${month}&step=${step + 1}`} style={{
          ...linkStyle, color: "#ffffff",
          background: COLOR.accent, border: `1px solid ${COLOR.accent}`,
        }}>
          {`다음 · ${STEPS[step]?.label ?? ""}`} →
        </Link>
      ) : (
        <span style={{ fontSize: 12.5, color: COLOR.faint }}>
          마지막 단계입니다.
        </span>
      )}
    </div>
  );
}
