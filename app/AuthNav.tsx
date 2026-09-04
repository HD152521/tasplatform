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

/** 세션이 살아 있으면 로그아웃, 아니면 로그인. */
export function AuthNav({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!signedIn) {
    return (
      <a href="/login" style={{ ...linkStyle, color: COLOR.accent, fontWeight: 600 }}>
        로그인 →
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
      {busy ? "로그아웃 중…" : "로그아웃"}
    </button>
  );
}
