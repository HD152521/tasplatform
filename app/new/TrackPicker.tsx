"use client";

import { COLOR, RADIUS } from "../ui.tsx";
import type { SrTrack } from "../../lib/jiraSrTicket.ts";

/**
 * 운영 / 개발 고르기.
 *
 * Jira 티켓 제목의 대괄호가 된다 — `[운영] <한글 제목> 진행`. 기존 티켓들이 쓰는 꼴이다.
 *
 * ## 왜 글만 보고 맞히지 않나
 *
 * 글에 "개발계", "스테이징" 같은 말이 있으면 미리 골라 두지만(`guessTrack`), 그것으로
 * **확정하지 않는다.** 틀린 구분으로 티켓이 올라가면 목록에서 엉뚱한 묶음에 섞이고,
 * 고치려면 사람이 Jira 를 열어야 한다. 라디오 두 개는 누르는 데 1초다.
 *
 * 기본값은 `운영` 이다 — 모르면 운영이 맞다.
 */
export function TrackPicker({
  value, onChange, disabled = false,
}: {
  value: SrTrack;
  onChange: (next: SrTrack) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="구분" style={{ display: "flex", gap: 6 }}>
      {(["운영", "개발"] as const).map((track) => {
        const on = value === track;
        return (
          <button
            key={track}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(track)}
            style={{
              padding: "7px 14px", fontSize: 12.5, fontWeight: on ? 600 : 400,
              fontFamily: "inherit",
              color: on ? "#ffffff" : COLOR.ink,
              background: on ? COLOR.accent : COLOR.surface,
              border: `1px solid ${on ? COLOR.accent : COLOR.field}`,
              borderRadius: RADIUS.control,
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {track}
          </button>
        );
      })}
    </div>
  );
}
