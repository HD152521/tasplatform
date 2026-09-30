"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { COLOR, Card, MONO_STACK, Notice, RADIUS } from "../ui.tsx";
import {
  MAX_PHOTO_LABEL,
  PHOTO_ACCEPT,
  PHOTO_JPEG_QUALITY,
  PHOTO_LONG_EDGE,
  PHOTO_SLOT_COUNT,
  PHOTO_TOO_LARGE_MESSAGE,
  MAX_PHOTO_BYTES,
  type ReportPhotoMeta,
} from "../../lib/reportPhotoLimits.ts";
import {
  PHOTO_HEIGHT,
  PHOTO_WIDTH,
  photoSeatLabel,
  layoutPhotoSlides,
} from "../../lib/reportPhotoLayout.ts";

/**
 * 4단계 · 정기점검 사진 (건너뛰기 가능).
 *
 * 넉 장을 받아 슬라이드 2장에 2장씩 넣는다. 자리 이름("슬라이드 1 · 왼쪽")을 그대로
 * 보여주는 이유는, 어느 사진이 보고서 어디에 박히는지를 만들기 전에 알아야 하기 때문이다.
 *
 * ## 왜 화면에서 줄이나
 *
 * 슬라이드에서 3.9×5.5인치밖에 차지하지 않는데 요즘 휴대폰 사진은 한 장이 5MB 다.
 * 원본을 DB 에 담을 이유가 없어서 긴 변 1600px 로 줄여 보낸다. 서버에 이미지 라이브러리를
 * 새로 들이지 않으려는 것이기도 하다 — 자세한 근거는 lib/reportPhotoLimits.ts 머리말에 있다.
 *
 * ## 왜 "건너뛰기" 를 눌러야 하나
 *
 * 그냥 다음으로 넘어간 것과 사진 없이 가기로 정한 것은 다르다. 구분이 없으면 보고서를
 * 만들 때 "사진을 잊은 사람" 에게도 아무것도 묻지 못한다.
 */

/** 저장된 사진과 방금 고른 사진을 같은 모양으로 다룬다. */
interface Seat {
  readonly slot: number;
  readonly meta: ReportPhotoMeta | null;
  /** 방금 고른 것의 미리보기 주소. 저장이 끝나도 그대로 쓴다 — 다시 받을 이유가 없다. */
  readonly localUrl: string | null;
}

function seatsFrom(photos: readonly ReportPhotoMeta[]): Seat[] {
  const bySlot = new Map(photos.map((p) => [p.slot, p]));
  return Array.from({ length: PHOTO_SLOT_COUNT }, (_, i) => ({
    slot: i + 1,
    meta: bySlot.get(i + 1) ?? null,
    localUrl: null,
  }));
}

function kb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 확장자를 .jpg 로 바꾼다. 줄이는 과정에서 JPEG 로 다시 그리기 때문이다. */
function asJpegName(raw: string): string {
  const base = raw.replace(/\.[^.]+$/, "");
  return `${base === "" ? "photo" : base}.jpg`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    // 브라우저가 못 읽는 형식(HEIC 등)은 여기로 온다. 사람에게 이유를 말해 준다.
    img.onerror = () => reject(new Error("사진을 읽을 수 없습니다. JPEG 또는 PNG 로 저장해 주세요."));
    img.src = url;
  });
}

/**
 * 긴 변을 PHOTO_LONG_EDGE 로 줄여 JPEG 로 다시 만든다.
 *
 * 원본이 이미 작으면 키우지 않는다(scale 상한 1) — 없는 화소를 만들어 봐야 용량만 는다.
 */
async function shrink(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (longest === 0) throw new Error("사진 크기를 알 수 없습니다.");
    const scale = Math.min(1, PHOTO_LONG_EDGE / longest);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("이 브라우저에서는 사진을 줄일 수 없습니다.");
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY);
    });
    if (blob === null) throw new Error("사진을 변환하지 못했습니다.");
    return new File([blob], asJpegName(file.name), { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function PhotoStep({
  month, photos, skipped,
}: {
  month: string;
  photos: readonly ReportPhotoMeta[];
  skipped: boolean;
}) {
  const router = useRouter();
  const [seats, setSeats] = useState<Seat[]>(() => seatsFrom(photos));
  const [skip, setSkip] = useState(skipped);
  /** 지금 손대고 있는 자리. null 이면 한가하다. 입력까지 같이 잠근다. */
  const [busySlot, setBusySlot] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const inputs = useRef<Record<number, HTMLInputElement | null>>({});

  const filled = seats.filter((s) => s.meta !== null);
  const slides = layoutPhotoSlides(filled.length).length;
  const busy = busySlot !== null;

  /** 채운 순서에서 몇 번째인가. 자리 이름은 이 순번으로 짓는다 — 중간을 비워도 앞에서부터 채워지므로. */
  function seatIndex(slot: number): number {
    return filled.findIndex((s) => s.slot === slot);
  }

  function update(slot: number, change: (seat: Seat) => Seat): void {
    setSeats((cur) => cur.map((s) => (s.slot === slot ? change(s) : s)));
  }

  async function pick(slot: number, file: File): Promise<void> {
    setError("");
    setNote("");
    if (file.size > MAX_PHOTO_BYTES) {
      setError(PHOTO_TOO_LARGE_MESSAGE);
      return;
    }

    setBusySlot(slot);
    try {
      const small = await shrink(file);
      const form = new FormData();
      form.set("month", month);
      form.set("slot", String(slot));
      form.set("file", small);

      const response = await fetch("/api/report/photos", { method: "POST", body: form });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean; message?: string; fileName?: string; bytes?: number; mime?: string;
      };
      if (!response.ok || body.ok !== true) {
        setError(body.message ?? `사진을 넣지 못했습니다 (HTTP ${response.status}).`);
        return;
      }

      const url = URL.createObjectURL(small);
      update(slot, (seat) => {
        if (seat.localUrl !== null) URL.revokeObjectURL(seat.localUrl);
        return {
          ...seat,
          localUrl: url,
          meta: {
            slot,
            fileName: body.fileName ?? small.name,
            mime: body.mime ?? "image/jpeg",
            bytes: body.bytes ?? small.size,
            savedAt: new Date().toISOString(),
          },
        };
      });
      // 사진을 넣었으면 건너뜀은 없어진다(서버도 같이 지운다).
      setSkip(false);
      setNote(`${small.name} 을 넣었습니다.`);
      // 위쪽 단계 표시가 서버에서 그려지므로 새로 받아야 체크가 바뀐다.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "사진을 넣는 중 오류가 발생했습니다.");
    } finally {
      setBusySlot(null);
      // 같은 파일을 다시 고를 수 있게 비운다. 비우지 않으면 onChange 가 안 뜬다.
      const input = inputs.current[slot];
      if (input) input.value = "";
    }
  }

  async function clear(slot: number): Promise<void> {
    setError("");
    setNote("");
    setBusySlot(slot);
    try {
      const response = await fetch(
        `/api/report/photos?month=${month}&slot=${slot}`, { method: "DELETE" },
      );
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!response.ok || body.ok !== true) {
        setError(body.message ?? `사진을 지우지 못했습니다 (HTTP ${response.status}).`);
        return;
      }
      update(slot, (seat) => {
        if (seat.localUrl !== null) URL.revokeObjectURL(seat.localUrl);
        return { ...seat, meta: null, localUrl: null };
      });
      setNote("사진을 지웠습니다.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "사진을 지우는 중 오류가 발생했습니다.");
    } finally {
      setBusySlot(null);
    }
  }

  /** 건너뛰기 / 되돌리기. 건너뛰면 넣어 둔 사진도 같이 없어진다. */
  async function decideSkip(next: boolean): Promise<void> {
    setError("");
    setNote("");
    setBusySlot(0);
    try {
      const response = await fetch("/api/report/photos/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, skipped: next }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!response.ok || body.ok !== true) {
        setError(body.message ?? `저장에 실패했습니다 (HTTP ${response.status}).`);
        return;
      }
      setSkip(next);
      if (next) {
        setSeats((cur) => cur.map((s) => {
          if (s.localUrl !== null) URL.revokeObjectURL(s.localUrl);
          return { ...s, meta: null, localUrl: null };
        }));
        setNote("사진 없이 보고서를 만듭니다.");
      } else {
        setNote("건너뛰기를 되돌렸습니다.");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 중 오류가 발생했습니다.");
    } finally {
      setBusySlot(null);
    }
  }

  return (
    <>
      {error !== "" && <Notice tone="error">{error}</Notice>}
      {note !== "" && error === "" && <Notice tone="ok">{note}</Notice>}

      {skip && (
        <Notice tone="warn">
          이 달은 <b>사진 없이</b> 만들기로 했습니다. 사진 슬라이드를 아예 붙이지 않습니다.
          <div style={{ marginTop: 9 }}>
            <button
              type="button" onClick={() => void decideSkip(false)} disabled={busy}
              style={{ ...ghost, cursor: busy ? "default" : "pointer" }}
            >
              {busy ? "처리 중…" : "건너뛰기 되돌리기"}
            </button>
          </div>
        </Notice>
      )}

      <Card style={{ padding: "18px 20px" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 12, marginBottom: 4, flexWrap: "wrap",
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: COLOR.faint, letterSpacing: "0.04em",
          }}>
            04 정기점검 사진
          </div>
          <span style={{ fontSize: 11.5, color: COLOR.muted }}>
            {skip
              ? "건너뜀"
              : `${filled.length}장 선택 · 슬라이드 ${slides}장`}
          </span>
          {!skip && (
            <button
              type="button" onClick={() => void decideSkip(true)} disabled={busy}
              style={{ ...ghost, marginLeft: "auto", cursor: busy ? "default" : "pointer" }}
            >
              {busy ? "처리 중…" : "사진 건너뛰기"}
            </button>
          )}
        </div>

        <p style={{ margin: "0 0 15px", fontSize: 11.5, color: COLOR.faint, lineHeight: 1.65 }}>
          {`넣은 사진이 순서대로 채워집니다 — 중간을 비워도 빈 사진틀은 생기지 않습니다. `}
          {`슬라이드에는 ${PHOTO_WIDTH}×${PHOTO_HEIGHT}인치 자리에 들어가고, `}
          {`고른 사진은 긴 변 ${PHOTO_LONG_EDGE}px 로 줄여 보관합니다 (장당 ${MAX_PHOTO_LABEL} 까지).`}
        </p>

        <div style={{
          display: "grid",
          // 좁아지면 한 줄로 떨어진다. minmax(0,1fr) 이 없으면 미리보기가 칸을 밀어 가로 스크롤이 생긴다.
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: 14,
        }}>
          {seats.map((seat) => {
            const index = seatIndex(seat.slot);
            const on = seat.meta !== null;
            const working = busySlot === seat.slot;
            return (
              <div
                key={seat.slot}
                style={{
                  border: `1px solid ${on ? COLOR.line : COLOR.field}`,
                  borderRadius: RADIUS.control,
                  padding: 11,
                  background: on ? COLOR.surface : COLOR.ground,
                  minWidth: 0,
                  boxSizing: "border-box",
                  opacity: skip ? 0.45 : 1,
                }}
              >
                <div style={{
                  display: "flex", alignItems: "baseline", gap: 7, marginBottom: 9, minWidth: 0,
                }}>
                  <span style={{
                    fontFamily: MONO_STACK, fontSize: 11, fontWeight: 700,
                    color: on ? COLOR.ok : COLOR.faint,
                  }}>
                    {on ? "✓" : seat.slot}
                  </span>
                  <span style={{
                    fontSize: 12, fontWeight: 600, color: on ? COLOR.ink : COLOR.faint,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {on && index >= 0 ? photoSeatLabel(index) : "비어 있음"}
                  </span>
                </div>

                <div style={{
                  // 슬라이드의 사진 자리와 같은 비율로 보여준다 — 만들고 나서 놀라지 않게.
                  // 높이를 고정하고 폭을 비율로 얻는다. 폭을 칸에 맡기면 넓은 화면에서
                  // 미리보기가 400px 넘게 자라 한 화면에 넉 장이 안 들어온다.
                  aspectRatio: `${PHOTO_WIDTH} / ${PHOTO_HEIGHT}`,
                  height: 190,
                  maxWidth: "100%",
                  margin: "0 auto 10px",
                  background: COLOR.ground,
                  border: `1px dashed ${COLOR.field}`,
                  borderRadius: RADIUS.badge,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  overflow: "hidden",
                }}>
                  {on ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={seat.localUrl
                        ?? `/api/report/photos?month=${month}&slot=${seat.slot}&v=${encodeURIComponent(seat.meta?.savedAt ?? "")}`}
                      alt={`${photoSeatLabel(Math.max(0, index))} 사진`}
                      style={{
                        // 슬라이드에서는 자리에 꽉 채워 들어가므로 미리보기도 같게 둔다.
                        width: "100%", height: "100%", objectFit: "fill", display: "block",
                      }}
                    />
                  ) : (
                    <span style={{ fontSize: 11, color: COLOR.faint }}>사진 없음</span>
                  )}
                </div>

                <div style={{
                  fontSize: 11, color: COLOR.muted, minHeight: 15, marginBottom: 9,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {on ? `${seat.meta?.fileName ?? ""} · ${kb(seat.meta?.bytes ?? 0)}` : ""}
                </div>

                <div style={{ display: "flex", gap: 7 }}>
                  <label
                    style={{
                      ...ghost, flex: 1, textAlign: "center",
                      // 잠글 때 버튼만 잠그고 입력을 열어 두면 같은 자리에 두 번 올라간다.
                      cursor: busy || skip ? "default" : "pointer",
                      opacity: busy || skip ? 0.6 : 1,
                    }}
                  >
                    {working ? "넣는 중…" : on ? "바꾸기" : "사진 고르기"}
                    <input
                      ref={(el) => { inputs.current[seat.slot] = el; }}
                      type="file" accept={PHOTO_ACCEPT} disabled={busy || skip}
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void pick(seat.slot, file);
                      }}
                    />
                  </label>
                  {on && (
                    <button
                      type="button" onClick={() => void clear(seat.slot)} disabled={busy}
                      style={{ ...ghost, cursor: busy ? "default" : "pointer" }}
                    >
                      지우기
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

const ghost: React.CSSProperties = {
  padding: "6px 12px", fontSize: 11.5, fontWeight: 500, color: COLOR.body,
  background: COLOR.surface, border: `1px solid ${COLOR.field}`,
  borderRadius: RADIUS.control, fontFamily: "inherit", boxSizing: "border-box",
  display: "inline-block",
};
