"use client";

import { useEffect, useRef, useState } from "react";
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
  MAX_ORIGINAL_BYTES,
  ORIGINAL_TOO_LARGE_MESSAGE,
  type ReportPhotoMeta,
} from "../../lib/reportPhotoLimits.ts";
import {
  PHOTO_HEIGHT,
  PHOTO_WIDTH,
  photoSeatLabel,
  layoutPhotoSlides,
} from "../../lib/reportPhotoLayout.ts";
import { dropTargetSlots, splitByPhotoMime } from "../../lib/reportPhotoDrop.ts";

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
 * ## 끌어다 놓기
 *
 * 네 장을 한 번에 끌어다 놓는 것이 이 화면의 보통 쓰임이다. 칸 아무 데나 놓으면
 * **빈 자리부터** 채우고, 특정 자리 위에 놓으면 그 자리부터 채운다(이미 든 사진도
 * 바꿔치운다 — 자리를 집어 놓은 것은 "여기에 이걸" 이라는 뜻이다).
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

/**
 * 사진을 시계방향 90도 돌린 새 파일을 만든다.
 *
 * 돌려서 **저장까지** 한다. 슬라이드에 넣을 때 각도만 주는 방법도 있지만, 그러면
 * 그림이 제 자리에서 회전할 뿐 차지하는 칸은 그대로라 가로로 긴 사진이 상자 밖으로
 * 삐져나간다. 파일 자체를 돌려 두면 그 뒤로는 평범한 세로 사진과 똑같이 다뤄진다.
 *
 * 줄이기(shrink)를 이미 거친 파일이라 다시 줄이지 않는다 — 긴 변은 그대로고
 * 가로세로만 바뀐다.
 */
async function rotate90(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (width === 0 || height === 0) throw new Error("사진 크기를 알 수 없습니다.");

    // 돌리면 가로세로가 바뀐다.
    const canvas = document.createElement("canvas");
    canvas.width = height;
    canvas.height = width;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("이 브라우저에서는 사진을 돌릴 수 없습니다.");
    // 새 캔버스의 오른쪽 위를 원점으로 삼아 90도 돌린 뒤 그린다.
    ctx.translate(height, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY);
    });
    if (blob === null) throw new Error("사진을 돌리지 못했습니다.");
    return new File([blob], file.name, { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 끌고 있는 것이 파일인가. 글자나 링크를 끌어와도 반응하지 않게 한다. */
function draggingFiles(data: DataTransfer): boolean {
  return Array.from(data.types).includes("Files");
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
  /** 지금 사진을 끌고 있는 자리. null 이면 안 끌고 있고, 0 은 칸 바깥(빈 자리부터). */
  const [overSlot, setOverSlot] = useState<number | null>(null);
  const inputs = useRef<Record<number, HTMLInputElement | null>>({});
  /**
   * 만들어 둔 미리보기 주소.
   *
   * 화면에 그리는 값은 seats 에 있지만, 되돌려줄(revoke) 때는 **가장 최신 값**을 알아야
   * 하는데 비동기 처리 중의 seats 는 옛 값으로 닫혀 있을 수 있다. 그래서 따로 들고 있는다.
   */
  const urls = useRef<Record<number, string>>({});

  function releaseUrl(slot: number): void {
    const url = urls.current[slot];
    if (url === undefined) return;
    URL.revokeObjectURL(url);
    delete urls.current[slot];
  }

  // 화면을 떠날 때 남은 미리보기 주소를 놓아준다. 안 놓으면 탭을 닫을 때까지 메모리에 남는다.
  useEffect(() => () => {
    for (const url of Object.values(urls.current)) URL.revokeObjectURL(url);
    urls.current = {};
  }, []);

  /*
   * 칸을 살짝 벗어나 놓아도 브라우저가 그 사진을 **열어 버리지 않게** 막는다.
   * 열리면 지금 화면이 사진으로 바뀌어, 넣던 작업과 앞 단계에서 고른 것이 날아간다.
   * 이 단계 화면에 있는 동안만 막는다.
   */
  useEffect(() => {
    function block(e: DragEvent): void {
      if (e.dataTransfer !== null && draggingFiles(e.dataTransfer)) e.preventDefault();
    }
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

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

  /**
   * 이미 줄여 둔 파일을 그 자리에 저장한다. 고르기와 돌리기가 함께 쓴다.
   *
   * 돌리기는 화면에 있는 사진을 다시 올리는 일이라 고르기와 저장 경로가 같아야 한다.
   * 따로 두면 한쪽만 고쳤을 때 조용히 갈라진다.
   *
   * 실패를 화면에 바로 쓰지 않고 **문구로 돌려준다**(성공이면 null). 끌어다 놓기는
   * 여러 장을 차례로 올리므로, 부른 쪽이 "몇 장째에서 멈췄다" 를 함께 말해야 한다.
   * 화면 새로 받기(router.refresh)도 부른 쪽이 한다 — 네 장을 넣을 때 장마다 새로
   * 받으면 그만큼 서버를 다시 때린다.
   */
  async function save(slot: number, small: File): Promise<string | null> {
    if (small.size > MAX_PHOTO_BYTES) return PHOTO_TOO_LARGE_MESSAGE;

    // 사진은 본문에 그대로 싣고 이름·자리는 주소에 둔다 — 라우트가 본문을 스트림으로
    // 읽으며 상한에서 끊기 때문이다(app/api/report/photos/route.ts 머리말).
    const query = new URLSearchParams({ month, slot: String(slot), name: small.name });
    const response = await fetch(`/api/report/photos?${query.toString()}`, {
      method: "POST",
      headers: { "Content-Type": small.type },
      body: small,
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean; message?: string; fileName?: string; bytes?: number; mime?: string;
    };
    if (!response.ok || body.ok !== true) {
      return body.message ?? `사진을 넣지 못했습니다 (HTTP ${response.status}).`;
    }

    const url = URL.createObjectURL(small);
    releaseUrl(slot);
    urls.current[slot] = url;
    update(slot, (seat) => ({
      ...seat,
      localUrl: url,
      meta: {
        slot,
        fileName: body.fileName ?? small.name,
        mime: body.mime ?? "image/jpeg",
        bytes: body.bytes ?? small.size,
        savedAt: new Date().toISOString(),
      },
    }));
    // 사진을 넣었으면 건너뜀은 없어진다(서버도 같이 지운다).
    setSkip(false);
    return null;
  }

  /** 그 자리 사진을 시계방향 90도 돌려 다시 저장한다. */
  async function turn(slot: number): Promise<void> {
    const seat = seats[seatIndex(slot)];
    const current = seat?.localUrl;
    setError("");
    setNote("");
    setBusySlot(slot);
    try {
      // 화면에 보이는 그 사진을 그대로 돌린다. 서버에서 다시 받지 않는다 —
      // 미리보기와 저장본이 어긋나면 사람이 무엇을 돌렸는지 알 수 없다.
      const source = current ?? `/api/report/photos?month=${encodeURIComponent(month)}&slot=${slot}`;
      const blob = await (await fetch(source)).blob();
      const name = seat?.meta?.fileName ?? `photo-${slot}.jpg`;
      const turned = await rotate90(new File([blob], name, { type: blob.type || "image/jpeg" }));
      const failed = await save(slot, turned);
      if (failed !== null) setError(failed);
      else {
        setNote("90도 돌렸습니다.");
        // 위쪽 단계 표시가 서버에서 그려지므로 새로 받아야 체크가 바뀐다.
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "사진을 돌리지 못했습니다.");
    } finally {
      setBusySlot(null);
    }
  }

  /** 한 장을 줄여 그 자리에 넣는다. 실패하면 보일 문구를, 성공하면 null. */
  async function putOne(slot: number, file: File): Promise<string | null> {
    // 여기서 재는 것은 **원본**이고, 상한도 원본용(MAX_ORIGINAL_BYTES)이다.
    // 저장 상한(4MB)으로 재면 휴대폰 사진은 줄여 보기도 전에 전부 거부당한다.
    if (file.size > MAX_ORIGINAL_BYTES) return ORIGINAL_TOO_LARGE_MESSAGE;
    try {
      return await save(slot, await shrink(file));
    } catch (e) {
      return e instanceof Error ? e.message : "사진을 넣는 중 오류가 발생했습니다.";
    }
  }

  /**
   * 받은 사진을 자리에 넣는다. 파일 고르기와 끌어다 놓기가 같이 쓴다.
   *
   * 한 장씩 **차례로** 올린다 — 라우트가 한 번에 한 장만 받고, 같이 보내면 어느
   * 것이 실패했는지 사람에게 말해 줄 수 없다.
   */
  async function putMany(
    files: readonly File[], rejected: readonly string[], firstSlot?: number,
  ): Promise<void> {
    setError("");
    setNote("");

    if (files.length === 0) {
      setError(rejected.length === 0
        ? "사진 파일을 끌어다 놓아 주세요."
        : `JPEG 또는 PNG 만 넣을 수 있습니다. 받지 않은 것: ${rejected.join(", ")}`);
      return;
    }

    const targets = dropTargetSlots(
      seats.map((s) => ({ slot: s.slot, filled: s.meta !== null })),
      files.length,
      firstSlot,
    );
    if (targets.length === 0) {
      setError(`자리가 ${PHOTO_SLOT_COUNT}칸뿐입니다. 바꿀 자리 위에 직접 놓아 주세요.`);
      return;
    }

    let saved = 0;
    let failed: string | null = null;
    try {
      for (const [i, slot] of targets.entries()) {
        const file = files[i];
        if (file === undefined) break;
        setBusySlot(slot);
        failed = await putOne(slot, file);
        if (failed !== null) break;
        saved += 1;
      }
    } finally {
      setBusySlot(null);
    }

    // 한 장이라도 들어갔으면 위쪽 단계 표시를 새로 받는다. 끝에 한 번만 부른다.
    if (saved > 0) router.refresh();

    if (failed !== null) {
      setError(saved === 0 ? failed : `${saved}장을 넣고 멈췄습니다 — ${failed}`);
      return;
    }

    // 넣지 못한 것이 있으면 **조용히 넘기지 않는다.** 네 장 놓고 셋만 들어갔는데
    // 아무 말이 없으면, 빠진 장은 보고서가 나온 뒤에야 드러난다.
    const over = files.length - targets.length;
    const aside = [
      over > 0 ? `자리가 없어 ${over}장은 넣지 않았습니다.` : "",
      rejected.length > 0 ? `JPEG·PNG 가 아니라 건너뛴 것: ${rejected.join(", ")}` : "",
    ].filter((s) => s !== "").join(" ");
    const tail = aside === "" ? "" : ` ${aside}`;
    // 한 장이면 이름을 말한다 — 어느 파일이 들어갔는지가 바로 확인거리다.
    const only = saved === 1 ? files[0] : undefined;
    setNote(only === undefined
      ? `${saved}장을 넣었습니다.${tail}`
      : `${asJpegName(only.name)} 을 넣었습니다.${tail}`);
  }

  /** 파일 고르기 창에서 고른 한 장. 끌어다 놓기와 같은 경로를 쓴다. */
  async function pick(slot: number, file: File): Promise<void> {
    try {
      await putMany([file], [], slot);
    } finally {
      // 같은 파일을 다시 고를 수 있게 비운다. 비우지 않으면 onChange 가 안 뜬다.
      const input = inputs.current[slot];
      if (input) input.value = "";
    }
  }

  /** 사진을 받을 수 있는 상태인가. 건너뜀이거나 올리는 중이면 받지 않는다. */
  const takesDrop = !skip && !busy;

  /**
   * 끌고 지나갈 때. slot 0 은 칸 바깥이다.
   *
   * preventDefault 를 **해야** 놓기(drop)가 일어난다. 빠뜨리면 브라우저가 기본
   * 동작으로 그 사진을 열어 버리고 이 화면이 사라진다.
   */
  function onDragOver(e: React.DragEvent, slot: number): void {
    if (!takesDrop || !draggingFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setOverSlot(slot);
  }

  function onDrop(e: React.DragEvent, slot: number): void {
    if (!takesDrop || !draggingFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setOverSlot(null);
    const { taken, left } = splitByPhotoMime(Array.from(e.dataTransfer.files));
    void putMany(taken, left, slot === 0 ? undefined : slot);
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
      releaseUrl(slot);
      update(slot, (seat) => ({ ...seat, meta: null, localUrl: null }));
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
        for (const seat of seats) releaseUrl(seat.slot);
        setSeats((cur) => cur.map((s) => ({ ...s, meta: null, localUrl: null })));
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
          <br />
          <b>사진을 아래 칸에 그대로 끌어다 놓으면 올라갑니다</b>
          {` — 여러 장을 한 번에 놓으면 빈 자리부터 채웁니다. 자리 하나를 집어 놓으면 그 자리부터 들어갑니다.`}
        </p>

        <div
          onDragOver={(e) => onDragOver(e, 0)}
          onDrop={(e) => onDrop(e, 0)}
          onDragLeave={(e) => {
            // 칸에서 칸으로 넘어갈 때도 dragleave 가 뜬다. 영역 안이면 무시한다 —
            // 안 그러면 끌고 지나가는 동안 테두리가 깜박인다.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setOverSlot(null);
          }}
          style={{
            display: "grid",
            // 좁아지면 한 줄로 떨어진다. minmax(0,1fr) 이 없으면 미리보기가 칸을 밀어 가로 스크롤이 생긴다.
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: 14,
            // 끌고 있는 동안만 테두리를 보여 준다. 늘 보이면 칸이 하나 더 있는 것처럼 보인다.
            outline: overSlot !== null ? `2px dashed ${COLOR.ok}` : "none",
            outlineOffset: 9,
            borderRadius: RADIUS.control,
          }}
        >
          {seats.map((seat) => {
            const index = seatIndex(seat.slot);
            const on = seat.meta !== null;
            const working = busySlot === seat.slot;
            return (
              <div
                key={seat.slot}
                onDragOver={(e) => onDragOver(e, seat.slot)}
                onDrop={(e) => onDrop(e, seat.slot)}
                style={{
                  border: `1px solid ${
                    overSlot === seat.slot ? COLOR.ok : on ? COLOR.line : COLOR.field
                  }`,
                  borderRadius: RADIUS.control,
                  padding: 11,
                  background: overSlot === seat.slot
                    ? COLOR.okBg
                    : on ? COLOR.surface : COLOR.ground,
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
                    <>
                      {/*
                        가로로 긴 사진을 세로 자리에 넣으면 남는 여백이 크다. 파일을
                        실제로 돌려 저장하므로, 돌린 뒤에는 평범한 세로 사진처럼 다뤄진다.
                      */}
                      <button
                        type="button" onClick={() => void turn(seat.slot)} disabled={busy}
                        title="시계방향으로 90도 돌립니다"
                        style={{ ...ghost, cursor: busy ? "default" : "pointer" }}
                      >
                        90도 회전
                      </button>
                      <button
                        type="button" onClick={() => void clear(seat.slot)} disabled={busy}
                        style={{ ...ghost, cursor: busy ? "default" : "pointer" }}
                      >
                        지우기
                      </button>
                    </>
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
