"use client";

import { useEffect, useRef, useState } from "react";
import { COLOR, RADIUS } from "../ui.tsx";

/**
 * Prod Release 고르기.
 *
 * ## 왜 글자로 받지 않나
 *
 * 전에는 그냥 입력칸이었다. 사람이 `TPCF 10.4` 라고 적었고, 칸에는 **필수** 표시까지
 * 붙어 있었다. 그런데 그 값은 등록 요청에 실리지 않았다 — 조용히 버려졌고, SR 은 전부
 * 템플릿에 박힌 `10.4.2` 로 올라갔다. 적은 사람은 그걸 알 길이 없었다.
 *
 * 포털이 받는 것은 글자가 아니라 **번호**(`releaseId`)다. 그래서 목록에서 고르게 한다.
 * 고르지 않으면 보내지 않고, 보내지 않는다는 사실을 화면에 적는다.
 *
 * ## 왜 검색형인가
 *
 * 포털의 이 필드가 검색형이다(minChar 1). 릴리스가 제품마다 수십~수백 개라 드롭다운에
 * 다 담을 것이 아니고, 빈 검색어로 받는 목록은 **전체가 아니다**(app/api/releases 머리말).
 * 그래서 사람이 치는 글자로 묻는다.
 */

export interface PickedRelease {
  readonly releaseId: number;
  readonly releaseDesc: string;
}

interface Release {
  releaseId: number;
  releaseDesc: string;
}

/** 글자를 멈춘 뒤 묻는다. 한 글자마다 포털에 묻지 않는다. */
const DEBOUNCE_MS = 350;
/** 화면에 보여줄 개수. 수백 개를 다 그리면 고를 수 없다. */
const SHOW = 12;

export function ReleasePicker({
  productId, value, onChange,
}: {
  /** 고른 제품. 바뀌면 고른 릴리스를 **버린다** — 다른 제품의 릴리스다. */
  productId: number;
  value: PickedRelease | null;
  onChange: (picked: PickedRelease | null) => void;
}) {
  const [text, setText] = useState(value?.releaseDesc ?? "");
  const [list, setList] = useState<Release[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  /** 입력이 아니라 밖에서 값이 바뀐 것인지 가른다(제품 변경·초안 복구). */
  const typed = useRef(false);

  /*
   * 제품이 바뀌면 고른 것을 버린다.
   *
   * 안 버리면 "제품은 GemFire, 릴리스는 TAS 것" 이 된다. 그 조합은 사람이 고른 적이
   * 없고, 포털이 받아 주면 더 나쁘다 — 틀린 버전으로 조용히 올라간다.
   */
  useEffect(() => {
    onChange(null);
    setText("");
    setList([]);
    setError("");
    setOpen(false);
    typed.current = false;
    // onChange 는 부모가 매번 새로 만들어 넘기므로 의존성에 넣지 않는다(무한 루프).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  /** 밖에서 값이 들어오면(초안 복구) 글자도 맞춰 둔다. */
  useEffect(() => {
    if (!typed.current && value !== null) setText(value.releaseDesc);
  }, [value]);

  useEffect(() => {
    if (!typed.current) return;
    const q = text.trim();
    if (q === "") {
      setList([]);
      setError("");
      return;
    }

    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/releases?productId=${productId}&q=${encodeURIComponent(q)}`,
          { cache: "no-store" },
        );
        const data = (await response.json()) as {
          ok?: boolean; releases?: Release[]; message?: string;
        };
        if (cancelled) return;
        if (data.ok !== true || !Array.isArray(data.releases)) {
          setList([]);
          setError(data.message ?? `릴리스를 받지 못했습니다 (HTTP ${response.status}).`);
          return;
        }
        setError("");
        setList(data.releases);
        setOpen(true);
      } catch (problem) {
        if (cancelled) return;
        setList([]);
        setError(problem instanceof Error ? problem.message : String(problem));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [productId, text]);

  /** 적은 글자와 **정확히** 같은 항목. 고르지 않고 지나갈 때 쓴다. */
  const exact = list.find((r) => r.releaseDesc.toLowerCase() === text.trim().toLowerCase());

  function pick(release: Release): void {
    typed.current = false;
    onChange({ releaseId: release.releaseId, releaseDesc: release.releaseDesc });
    setText(release.releaseDesc);
    setOpen(false);
  }

  return (
    <div style={{ position: "relative" }}>
      <input
        value={text}
        onChange={(e) => {
          typed.current = true;
          setText(e.target.value);
          // 글자를 고치면 고른 것은 무효다. 안 비우면 화면의 글자와 보낼 번호가 어긋난다.
          if (value !== null) onChange(null);
        }}
        onFocus={() => { if (list.length > 0) setOpen(true); }}
        // 고르기 전에 칸을 떠나면, 적은 글자와 똑같은 항목이 있을 때만 집어 준다.
        // 비슷한 것을 알아서 고르지 않는다 — 틀린 버전으로 올라가는 것이 최악이다.
        onBlur={() => {
          setTimeout(() => {
            setOpen(false);
            if (value === null && exact !== undefined) pick(exact);
          }, 120);
        }}
        placeholder="버전을 적으면 목록이 나옵니다 (예: 10.4)"
        aria-label="Prod Release"
        style={{
          width: "100%", boxSizing: "border-box", padding: "8px 11px",
          fontSize: 13, fontFamily: "inherit", color: COLOR.ink,
          border: `1px solid ${value !== null ? "#9ccfae" : COLOR.field}`,
          borderRadius: RADIUS.control, outline: "none",
          background: value !== null ? "#f3fbf6" : COLOR.surface,
        }}
      />

      {open && list.length > 0 && (
        <ul style={{
          position: "absolute", zIndex: 20, left: 0, right: 0, top: "calc(100% + 4px)",
          margin: 0, padding: 4, listStyle: "none", maxHeight: 220, overflowY: "auto",
          background: COLOR.surface, border: `1px solid ${COLOR.field}`,
          borderRadius: RADIUS.control, boxShadow: "0 6px 18px rgba(0,0,0,0.08)",
        }}>
          {list.slice(0, SHOW).map((r) => (
            <li key={r.releaseId}>
              <button
                type="button"
                // onBlur 보다 먼저 집도록 mousedown 에서 고른다.
                onMouseDown={(e) => { e.preventDefault(); pick(r); }}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "6px 9px", fontSize: 12.5, fontFamily: "inherit",
                  color: COLOR.ink, background: "none", border: "none",
                  borderRadius: 4, cursor: "pointer",
                }}
              >
                {r.releaseDesc}
              </button>
            </li>
          ))}
          {list.length > SHOW && (
            <li style={{ padding: "5px 9px", fontSize: 11, color: COLOR.faint }}>
              {`${list.length - SHOW}개 더 있습니다 — 더 적으면 좁혀집니다`}
            </li>
          )}
        </ul>
      )}

      <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.5, minHeight: 16 }}>
        {error !== "" ? (
          <span style={{ color: COLOR.waitUs }}>{error}</span>
        ) : busy ? (
          <span style={{ color: COLOR.faint }}>찾는 중…</span>
        ) : value !== null ? (
          <span style={{ color: COLOR.ok }}>{`${value.releaseDesc} 로 올라갑니다`}</span>
        ) : text.trim() !== "" ? (
          // **고르지 않으면 안 보낸다**는 사실을 반드시 말한다. 전에 조용히 버려서
          // 사람이 적은 버전과 올라간 버전이 달랐다.
          <span style={{ color: COLOR.warn }}>목록에서 골라야 전송됩니다</span>
        ) : (
          <span style={{ color: COLOR.faint }}>고르지 않으면 버전 없이 등록됩니다</span>
        )}
      </div>
    </div>
  );
}
