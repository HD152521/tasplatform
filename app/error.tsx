"use client";

/**
 * 한 화면이 터졌을 때 보여 주는 자리.
 *
 * ## 왜 두나
 *
 * 이게 없으면 Next 는 `Application error: a client-side exception has occurred
 * (see the browser console for more information)` 한 줄만 남기고 화면을 **통째로**
 * 비운다. 쓰는 사람이 할 수 있는 말은 "대시보드 안 됨" 뿐이고, 고치는 쪽은 콘솔을
 * 열 수 있는 사람이 올 때까지 아무것도 모른다. 실제로 그 한 줄 때문에 원인 가리는
 * 데 한참을 썼다 — **고친 코드는 이미 있었고 배포가 안 돌고 있었다.**
 *
 * 그래서 여기서 **진짜 메시지를 화면에 적는다.** 사람이 그 한 줄을 그대로 전해 주면
 * 그걸로 끝난다.
 *
 * ## 무엇을 적나
 *
 *   - 메시지: 브라우저에서 터진 오류는 운영 빌드에서도 원문이 남는다.
 *   - `digest`: 서버에서 터진 것은 운영 빌드가 원문을 지우고 이 해시만 준다.
 *     컨테이너 로그(`cf logs broadcom-sr-web --recent`)에서 같은 해시를 찾으면 원문이 있다.
 *   - 빌드 커밋: **어느 빌드가 터졌는지**를 함께 적는다. 이게 없으면 "고쳤는데 아직도"
 *     가 배포 누락인지 코드 문제인지 또 못 가린다(/api/health 의 version 과 같은 값).
 *
 * 다시 시도 버튼은 `reset()` 이다 — 일시적인 오류(한 번 끊긴 조회)면 그걸로 돌아온다.
 */
import { useEffect } from "react";
import { COLOR, MONO_STACK } from "./ui.tsx";

export default function RouteError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // 콘솔에도 남긴다 — 화면을 캡처해 보내는 사람과, 콘솔을 여는 사람이 다르다.
  useEffect(() => {
    console.error("[화면 오류]", error);
  }, [error]);

  return (
    <div style={{ padding: "40px 0 60px", maxWidth: 720 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
        이 화면을 그리다 멈췄습니다
      </h1>
      <p style={{ margin: "10px 0 0", fontSize: 13, color: COLOR.muted, lineHeight: 1.7 }}>
        다른 화면은 멀쩡합니다. 아래 한 줄을 그대로 전해 주시면 원인을 바로 찾습니다.
      </p>

      <pre style={{
        margin: "18px 0 0", padding: "13px 15px",
        background: COLOR.ground, border: `1px solid ${COLOR.line}`, borderRadius: 10,
        fontFamily: MONO_STACK, fontSize: 12, lineHeight: 1.7, color: COLOR.ink,
        whiteSpace: "pre-wrap", wordBreak: "break-all",
      }}>
        {error.message === "" ? "(메시지 없음)" : error.message}
        {error.digest !== undefined && `\ndigest: ${error.digest}`}
      </pre>

      <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={reset}
          style={{
            fontSize: 13, fontFamily: "inherit", cursor: "pointer", fontWeight: 600,
            color: "#fff", background: COLOR.accent, border: "none",
            borderRadius: 8, padding: "9px 14px",
          }}
        >
          다시 시도
        </button>
        <a
          href="/"
          style={{
            fontSize: 13, fontWeight: 600, textDecoration: "none",
            color: COLOR.ink, background: COLOR.surface,
            border: `1px solid ${COLOR.field}`, borderRadius: 8, padding: "9px 14px",
          }}
        >
          진행중 목록으로
        </a>
      </div>
    </div>
  );
}
