"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { COLOR } from "./ui.tsx";

const linkStyle = {
  fontSize: 12,
  color: COLOR.muted,
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  fontFamily: "inherit",
  textDecoration: "none",
} as const;

/**
 * **브로드컴 포털** 세션을 다룬다 — 이 도구를 쓰는 사람의 로그아웃은 SideNav 의
 * UserChipRow 에 있다. 두 개가 한 화면에 나란히 보이므로 라벨에 「포털」을 박아 둔다.
 * 여기의 「해제」는 **수집을 멈춘다**(재로그인이 필요해진다). 사람 로그아웃과 헷갈리면
 * 엉뚱한 쪽을 끊는다.
 */
export function AuthNav({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!signedIn) {
    return (
      <a href="/login" style={{ ...linkStyle, color: COLOR.accent, fontWeight: 600 }}>
        포털 로그인 →
      </a>
    );
  }

  async function logout(): Promise<void> {
    setBusy(true);
    try {
      await fetch("/api/logout", { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={logout} disabled={busy} style={linkStyle}>
      {busy ? "해제 중…" : "포털 세션 해제"}
    </button>
  );
}
