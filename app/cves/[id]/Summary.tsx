"use client";

import { useState } from "react";
import { COLOR, Card, controlStyle } from "../../ui.tsx";

/**
 * 설명 표시.
 *
 * 한국어 번역이 있으면 그걸 먼저 보여주되, 원문 확인이 필요할 때가 있어
 * 전환 버튼을 둔다. 번역은 기계 번역이므로 원문이 항상 근거다.
 */
export function Summary({ original, korean }: { original: string; korean: string }) {
  const hasKo = korean.trim() !== "";
  const [showOriginal, setShowOriginal] = useState(!hasKo);
  const text = showOriginal ? original : korean;

  return (
    <Card style={{ padding: "18px 20px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 11 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, color: COLOR.faint, letterSpacing: "0.04em",
        }}>
          설명
        </span>
        {hasKo && (
          <>
            <span style={{ fontSize: 11, color: COLOR.faint }}>
              {showOriginal ? "원문" : "한국어 번역"}
            </span>
            <button
              type="button" onClick={() => setShowOriginal((v) => !v)}
              style={{ ...controlStyle, marginLeft: "auto", padding: "4px 10px", fontSize: 11.5 }}
            >
              {showOriginal ? "번역 보기" : "원문 보기"}
            </button>
          </>
        )}
      </div>

      <p style={{
        margin: 0, fontSize: 14, lineHeight: 1.8,
        color: COLOR.body, whiteSpace: "pre-wrap",
      }}>
        {text === "" ? "(설명 없음)" : text}
      </p>

      {hasKo && !showOriginal && (
        <p style={{ margin: "12px 0 0", fontSize: 11.5, color: COLOR.faint, lineHeight: 1.6 }}>
          기계 번역입니다. 정확한 판단은 원문을 확인하세요.
        </p>
      )}
    </Card>
  );
}
