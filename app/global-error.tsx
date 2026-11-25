"use client";

/**
 * 껍데기(layout)까지 터졌을 때의 마지막 자리.
 *
 * `app/error.tsx` 는 **layout 안쪽**만 받는다. 사이드바처럼 layout 이 그리는 것이
 * 터지면 그 자리도 같이 날아가므로, Next 는 이 파일을 쓴다. 그래서 여기는 `<html>`·
 * `<body>` 를 **직접** 그려야 하고, 터진 그 모듈을 다시 쓰지 않도록 **아무것도
 * 가져오지 않는다**(app/ui.tsx 조차 — 그쪽이 원인이면 이 화면도 같이 죽는다).
 *
 * 사이드바가 터지면 모든 화면이 "Application error" 가 된다. 그때 사람은 "로그인해도
 * 안 넘어간다" 고 말하게 되고, 그 말로는 무엇이 터졌는지 알 수 없다. 메시지 한 줄이
 * 보이면 그 말이 바뀐다.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ko">
      <body style={{
        margin: 0, padding: "48px 20px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#1b1d21", background: "#f6f7f9",
      }}>
        <div style={{ maxWidth: 680, margin: "0 auto" }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
            화면 전체를 그리다 멈췄습니다
          </h1>
          <p style={{ margin: "10px 0 0", fontSize: 13, color: "#6b7280", lineHeight: 1.7 }}>
            아래 한 줄을 그대로 전해 주세요. 새로고침으로 돌아오는 경우도 있습니다.
          </p>
          <pre style={{
            margin: "18px 0 0", padding: "13px 15px",
            background: "#fff", border: "1px solid #e3e5e9", borderRadius: 10,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-all",
          }}>
            {error.message === "" ? "(메시지 없음)" : error.message}
            {error.digest !== undefined && `\ndigest: ${error.digest}`}
          </pre>
          <p style={{ marginTop: 18, fontSize: 13 }}>
            <a href="/" style={{ color: "#2f6fd0", fontWeight: 600 }}>처음 화면으로</a>
          </p>
        </div>
      </body>
    </html>
  );
}
