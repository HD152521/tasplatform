"use client";

/**
 * 등록 바.
 *
 * 예전에는 오른쪽에 "포털에 옮겨적을 값" 사이드바가 있었다. 이 도구가 SR 을 직접
 * 등록하지 못하던 시절, 값을 채워 놓고 **사람이 포털에 복붙하던** 흔적이다
 * (DraftForm 머리말 참고). 지금은 /api/create 가 바로 등록하므로, 왼쪽에 이미 보이는
 * 값을 400px 짜리 칸에 그대로 한 번 더 그릴 이유가 없다.
 *
 * 남은 일은 셋뿐이다 — 무엇이 덜 찼는지 알려주고, 필요하면 복사하게 해 주고, 등록한다.
 * 화면 아래에 붙여 두어 어디서 쓰고 있든 손이 닿는다.
 */
import { COLOR, RADIUS } from "../ui.tsx";

export function SubmitBar({
  missing, busy, stage, onStage, onSubmit, error,
  onCopy, copied,
}: {
  /** 아직 안 채운 필수 항목 이름. */
  missing: readonly string[];
  busy: boolean;
  stage: "write" | "confirm";
  onStage: (next: "write" | "confirm") => void;
  onSubmit: () => void;
  error: string;
  /** 세션이 끊겼을 때 손으로 포털에 옮길 수 있게 남겨 둔 탈출구. */
  onCopy: () => void;
  copied: boolean;
}) {
  const ready = missing.length === 0;

  return (
    <div style={{
      position: "sticky", bottom: 0, zIndex: 5,
      background: COLOR.surface, border: `1px solid ${COLOR.line}`,
      borderRadius: RADIUS.card, padding: "13px 18px",
      boxShadow: "0 -1px 12px rgba(20,23,26,.06)",
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
    }}>
      {stage === "write" ? (
        <>
          <span style={{ fontSize: 12.5, color: ready ? COLOR.ok : COLOR.muted }}>
            {ready
              ? "필수 항목을 다 채웠습니다."
              : `아직 필요합니다 — ${missing.join(", ")}`}
          </span>

          {error !== "" && (
            <span style={{
              fontSize: 12.5, color: COLOR.waitUs, background: COLOR.waitUsBg,
              border: "1px solid #f3c7c2", borderRadius: RADIUS.control,
              padding: "6px 11px", lineHeight: 1.5,
            }}>
              {error}
            </span>
          )}

          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button" onClick={onCopy}
              style={{
                padding: "8px 13px", fontSize: 12.5, fontFamily: "inherit",
                border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
                background: COLOR.surface, color: COLOR.body, cursor: "pointer",
              }}
            >
              {copied ? "복사됨" : "제목·본문 복사"}
            </button>
            <button
              type="button" onClick={() => onStage("confirm")} disabled={!ready}
              style={{
                padding: "9px 20px", fontSize: 13.5, fontWeight: 600, fontFamily: "inherit",
                borderRadius: RADIUS.control,
                border: `1px solid ${ready ? COLOR.accent : COLOR.field}`,
                background: ready ? COLOR.accent : COLOR.ground,
                color: ready ? "#ffffff" : COLOR.faint,
                cursor: ready ? "pointer" : "default",
              }}
            >
              SR 등록
            </button>
          </span>
        </>
      ) : (
        <>
          <span style={{ fontSize: 12.5, color: COLOR.warn, lineHeight: 1.6 }}>
            위 내용으로 <b>새 케이스가 등록</b>됩니다. 담당 엔지니어가 배정되어 바로 읽습니다.
          </span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button
              type="button" onClick={() => onStage("write")} disabled={busy}
              style={{
                padding: "9px 15px", fontSize: 13, fontFamily: "inherit",
                border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
                background: COLOR.surface, color: COLOR.body,
                cursor: busy ? "default" : "pointer",
              }}
            >
              고치기
            </button>
            <button
              type="button" onClick={onSubmit} disabled={busy}
              style={{
                padding: "9px 20px", fontSize: 13.5, fontWeight: 600, fontFamily: "inherit",
                borderRadius: RADIUS.control,
                border: `1px solid ${busy ? COLOR.muted : COLOR.waitUs}`,
                background: busy ? COLOR.muted : COLOR.waitUs, color: "#ffffff",
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "등록 중…" : "확인, 등록합니다"}
            </button>
          </span>
        </>
      )}
    </div>
  );
}
