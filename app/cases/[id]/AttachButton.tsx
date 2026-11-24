"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { COLOR, controlStyle, RADIUS, SPACE, TEXT, WEIGHT } from "../../ui.tsx";
import {
  MAX_UPLOAD_LABEL,
  checkUploadRequest,
  pastedImageName,
} from "../../../lib/attachmentUpload.ts";
import { isShrinkableImage, shrinkImage } from "../../../lib/imageShrink.ts";
import { isSessionFailure } from "../../../lib/writeFailure.ts";

/**
 * 끝나기를 기다리는 상한.
 *
 * 수집기가 집어가는 데 최대 15초(확인 주기), 브라우저로 케이스에 들어가는 데 10초,
 * 조각을 올리는 데 몇 초. 넘겨도 실패로 부르지 않는다 — 큐에 남아 결국 올라간다.
 */
const WAIT_MS = 120_000;
/** 얼마나 자주 되묻는지. */
const POLL_MS = 2_000;
/** 연달아 이만큼 못 물으면 손을 든다(그래도 "실패" 라고 말하지 않는다). */
const MAX_MISSES = 5;

/**
 * 한 건의 결과.
 *
 * 성공·실패만으로는 모자란다. **"올라갔지만 확인은 못 했다"** 라는 셋째 경우가 있고
 * (lib/crushftp.ts 의 unverified), 그걸 실패로 묶으면 사람이 다시 올려 케이스에 같은
 * 파일이 두 번 붙는다. 성공으로 묶어 조용히 넘기면 포털에서 확인할 생각을 못 한다.
 */
interface OneResult {
  /** 빈 문자열이면 성공. */
  readonly error: string;
  /** 성공했지만 덧붙일 말. 빈 문자열이면 할 말 없음. */
  readonly note: string;
}

/**
 * 파일 붙이기.
 *
 * ## 답변 전송과 별개다
 *
 * 고르는 즉시 올라간다. 답변 본문과 함께 가지 **않는다** — 첨부는 포털이 아니라
 * supportftp 로 가고, 그건 브라우저가 있는 수집기가 따로 처리하는 일이다
 * (app/api/attachments/upload). 두 개가 한 번에 가는 줄 알면 사람은 파일만 고르고
 * 전송을 누르지 않거나, 반대로 전송했으니 파일도 갔다고 믿는다. 그래서 버튼 이름과
 * title, 그리고 끝난 뒤 문구에서 매번 "따로" 라고 말한다.
 *
 * ## 왜 진행 초를 세는가
 *
 * 수집기가 집어가는 데 최대 15초, 브라우저로 케이스에 들어가는 데 10초가 더 든다.
 * 그 사이에 화면이 조용하면 사람은 고장 난 줄 알고 다시 누른다 — 그러면 케이스에 같은
 * 파일이 두 번 붙는다. 그래서 버튼을 잠그고, 얼마나 지났는지 숫자로 보여준다.
 *
 * ## 붙여넣기·끌어다 놓기는 **확인을 받고** 올린다
 *
 * 화면 캡처는 `Ctrl+V` 가 전부다. 파일로 저장한 뒤 고르게 하면 그 한 걸음에서 사람이
 * 포털로 돌아간다. 그래서 창 전체에서 붙여넣기와 끌어다 놓기를 받는다.
 *
 * 다만 **고른 파일과 달리 즉시 올리지 않는다.** 클립보드에 뭐가 있었는지 사람은 모르고
 * (이름도 없다 — 브라우저가 전부 `image.png` 로 준다), 잘못 올린 첨부는 고객 케이스에
 * 남는다. 그래서 미리보기와 이름을 보여 주고 한 번 더 누르게 한다.
 *
 * ## 줄여서 올릴지도 사람이 고른다
 *
 * 4K 캡처 PNG 는 8~15MB 고, 줄이면 300KB 가 된다. 그래도 **조용히 줄이지 않는다** —
 * 이 첨부는 고객 케이스의 증거이고, 오류 메시지가 적힌 캡처를 1600px JPEG 로 바꾸면
 * 글자가 뭉개져 읽을 수 없게 되는 일이 실제로 있다. 두 크기를 함께 보여 주고 고르게
 * 한다(lib/imageShrink.ts 머리말).
 *
 * ## 실패하면 같은 파일을 다시 고를 수 있어야 한다
 *
 * `<input type="file">` 은 같은 파일을 다시 고르면 change 가 오지 않는다. 값이 그대로라
 * 브라우저가 변경으로 보지 않기 때문이다. 세션이 끊겨 한 번 실패한 뒤 사람이 로그인하고
 * 같은 파일을 다시 고르는 것이 가장 흔한 흐름인데, 그때 아무 일도 일어나지 않으면
 * 고쳐지지 않는 고장으로 보인다. 그래서 끝날 때마다 value 를 비운다.
 */
/** 올리기 전에 확인을 기다리는 이미지 한 장. */
interface Staged {
  /** 붙여넣은 그대로. 이름은 우리가 만들어 붙였다. */
  readonly original: File;
  /** 줄인 것. 아직 만드는 중이면 null, 줄일 수 없는 형식이면 null 로 남는다. */
  readonly shrunk: File | null;
  /** 미리보기 주소. 반드시 revoke 해야 한다 — 안 하면 큰 이미지가 메모리에 남는다. */
  readonly preview: string;
  /** 줄이기가 실패한 사유. 비어 있으면 할 말 없음. */
  readonly shrinkError: string;
}

export function AttachButton({
  requestId, actorName = "",
}: {
  requestId: number;
  /** 붙여넣은 화면 캡처의 이름에 들어간다. 클립보드 파일은 이름이 없다. */
  actorName?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState("");
  /** 올라갔지만 확인은 못 한 건들. 실패(error)와 색·문구를 달리 쓴다. */
  const [warn, setWarn] = useState("");
  /** 이번에 올리는 개수. 0 이면 놀고 있다. */
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  /** 붙여넣거나 끌어다 놓은 이미지. 확인을 누를 때까지 올리지 않는다. */
  const [staged, setStaged] = useState<Staged | null>(null);
  /** 창 위로 파일을 끌고 있는가. 받을 수 있다는 것을 보여 준다. */
  const [dragging, setDragging] = useState(false);

  // 올리는 동안만 초를 센다. busy 가 풀리면 정리된다(간격이 남아 돌지 않게).
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [busy]);

  /**
   * 한 건. 성공이면 빈 문자열, 실패면 사유.
   *
   * **두 번에 나눠 부른다.** 예전에는 POST 하나가 수집기가 올릴 때까지 최대 120초를
   * 붙잡고 있었는데, 그 사이 바이트가 오가지 않는 연결은 VPN·TAS 라우터가 끊었다 —
   * 담당자는 10~20초 만에 "fetch 실패" 를 봤고, 파일은 정작 올라가 있었다.
   * 지금은 올려 놓고(POST) 끝났는지만 되물어(GET) 긴 연결을 아예 만들지 않는다.
   */
  async function uploadOne(file: File): Promise<OneResult> {
    let jobId: number;
    try {
      const body = new FormData();
      body.append("requestId", String(requestId));
      body.append("file", file);
      const response = await fetch("/api/attachments/upload", { method: "POST", body });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean; jobId?: number; message?: string;
      };
      if (data.ok !== true || typeof data.jobId !== "number") {
        return { error: data.message ?? `올리지 못했습니다 (HTTP ${response.status}).`, note: "" };
      }
      jobId = data.jobId;
    } catch (problem) {
      // 파일을 보내는 중에 끊긴 것이다. **자동으로 다시 보내지 않는다** — 큐에는
      // 들어갔는데 응답만 못 받은 경우일 수 있고, 그러면 같은 파일이 두 번 붙는다.
      const why = problem instanceof Error ? problem.message : String(problem);
      return { error: `${why} (올라갔는지는 잠시 후 케이스를 새로고침해 확인하세요)`, note: "" };
    }
    return waitForJob(jobId);
  }

  /**
   * 그 일이 끝날 때까지 되묻는다.
   *
   * 확인이 한 번 실패해도 **포기하지 않는다.** 일은 서버 큐에 그대로 있고 수집기가
   * 올린다 — 여기서 실패라고 말하면 사람이 다시 올려 같은 파일이 두 번 붙는다.
   * 연달아 못 물을 때만 손을 든다.
   */
  async function waitForJob(jobId: number): Promise<OneResult> {
    const deadline = Date.now() + WAIT_MS;
    let misses = 0;

    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const response = await fetch(
          `/api/attachments/upload?job=${jobId}&requestId=${requestId}`,
          { cache: "no-store" },
        );
        const data = (await response.json().catch(() => ({}))) as {
          ok?: boolean; code?: string; state?: string; message?: string; note?: string;
        };
        if (data.ok === true) {
          misses = 0;
          // done 인데 note 가 있으면 "올라갔지만 확인은 못 했다" 다. 성공으로 끝내되
          // 그 말을 버리지 않는다 — 삼키면 사람이 포털에서 확인할 생각을 못 한다.
          if (data.state === "done") return { error: "", note: data.note ?? "" };
          if (data.state === "failed") {
            return { error: data.message ?? "첨부를 올리지 못했습니다.", note: "" };
          }
        } else if (isSessionFailure(data.code)) {
          // 세션이 끊기면 다시 물어도 같은 답이다. 다섯 번 헛물을 켜지 않고 바로 말한다.
          // **올리지 못했다고 말하지 않는다** — 파일은 줄에 남아 수집기가 올린다.
          return {
            error: "세션이 끊겨 진행 상황을 확인할 수 없습니다. 파일은 줄에 남아 있으니 다시 올리지 말고, 로그인한 뒤 케이스를 새로고침해 확인하세요.",
            note: "",
          };
        } else {
          misses += 1;
        }
      } catch {
        misses += 1;
      }

      if (misses >= MAX_MISSES) {
        return {
          error: "진행 상황을 확인할 수 없습니다. 잠시 후 케이스를 새로고침해 확인하세요 (다시 올리지 마세요).",
          note: "",
        };
      }
      if (Date.now() > deadline) {
        // 상한을 넘겨도 **실패가 아니다.** 일은 큐에 남아 있고 수집기가 결국 올린다.
        //
        // 다만 **수집기가 멈춰 있으면 영원히 안 올라간다.** 그 가능성을 여기서 말해 준다 —
        // 왼쪽 아래 세션 표시가 수집기 상태를 보여 준다(app/SessionDot.tsx). 그 한 줄이
        // 없으면 사람은 "조금 더 기다리면 되겠지" 로 하루를 보낸다.
        return {
          error:
            "수집기가 아직 올리는 중입니다. 다시 올리지 말고 잠시 후 케이스를 새로고침해 확인하세요."
            + " 계속 그대로면 왼쪽 아래 세션 표시에서 수집기가 돌고 있는지 확인하세요.",
          note: "",
        };
      }
    }
  }

  /**
   * 고른 파일들을 올린다.
   *
   * **한꺼번에 보낸다(순차가 아니라).** 수집기는 한 회차에 브라우저를 한 번만 띄우고
   * 큐를 비울 때까지 돈다. 그래서 세 개를 동시에 넣으면 브라우저 한 번으로 세 개가
   * 처리된다 — 하나씩 기다려 보내면 매번 브라우저를 새로 띄워 세 배가 걸린다.
   *
   * 크기·이름 검사는 **보내기 전에 전부** 한다. 절반 올린 뒤 나머지가 거절당하면
   * 사람은 무엇이 올라갔는지 모른다.
   */
  async function upload(files: readonly File[]): Promise<void> {
    setNote("");
    setError("");
    setWarn("");

    // 서버가 판정하는 것과 같은 규칙으로 먼저 걸러 준다. 상한을 넘는 파일을 다 올려보낸
    // 뒤에 거절당하면 회선만 쓰고 사람은 그동안 기다린다.
    const rejected: string[] = [];
    for (const file of files) {
      const check = checkUploadRequest({ requestId, fileName: file.name, size: file.size });
      if (!check.ok) rejected.push(`${file.name}: ${check.message}`);
    }
    if (rejected.length > 0) {
      setError(rejected.join(" / "));
      return;
    }

    setTotal(files.length);
    setBusy(true);
    try {
      const results = await Promise.all(files.map((file) => uploadOne(file)));
      const label = (i: number): string => files[i]?.name ?? "?";
      const failed = results
        .map((r, i) => (r.error === "" ? "" : `${label(i)}: ${r.error}`))
        .filter((line) => line !== "");
      // 올라갔지만 확인은 못 한 건들. 실패와 섞지 않는다 — 처방이 정반대다
      // (실패는 다시 올려야 하고, 이쪽은 **다시 올리면 중복**이다).
      const notes = results
        .map((r, i) => (r.note === "" ? "" : `${label(i)}: ${r.note}`))
        .filter((line) => line !== "");
      const okCount = results.length - failed.length;

      if (failed.length > 0) {
        // 성공한 것도 함께 알린다. 그걸 안 알리면 전부 실패한 줄 알고 다시 올려
        // 케이스에 같은 파일이 두 번 붙는다.
        setError(
          okCount > 0
            ? `${okCount}개는 올렸고 ${failed.length}개가 실패했습니다 — ${failed.join(" / ")}`
            : failed.join(" / "),
        );
      } else {
        setNote(okCount === 1
          ? `${files[0]?.name ?? "파일"} 을 올렸습니다. 답변 전송과는 별개입니다.`
          : `${okCount}개를 올렸습니다. 답변 전송과는 별개입니다.`);
      }
      if (notes.length > 0) setWarn(notes.join(" / "));
      // 첨부 목록은 다음 수집에 반영되므로 지금 보이지 않을 수 있다. 그래도 새로
      // 읽어 둔다 — 이미 반영된 경우에 사람이 바로 확인할 수 있다.
      router.refresh();
    } finally {
      setBusy(false);
      setTotal(0);
    }
  }

  /**
   * 붙여넣은 이미지를 올릴 후보로 세운다.
   *
   * 이름을 **우리가 만든다.** 클립보드 파일은 전부 `image.png` 라, 그대로 올리면
   * 케이스에 같은 이름이 쌓여 무엇이 무엇인지 알 수 없다(pastedImageName).
   *
   * 줄인 것은 **여기서 미리 만들어 둔다.** 버튼에 실제 크기를 적어 주려면 만들어 봐야
   * 알고, 누른 뒤에 만들면 그 몇 초 동안 화면이 조용하다.
   */
  function stage(file: File): void {
    setError("");
    setNote("");
    setWarn("");

    const named = new File(
      [file],
      pastedImageName({ at: new Date(), who: actorName, mime: file.type }),
      { type: file.type },
    );
    const check = checkUploadRequest({ requestId, fileName: named.name, size: named.size });
    if (!check.ok) {
      setError(check.message);
      return;
    }

    const preview = URL.createObjectURL(named);
    setStaged((prev) => {
      // 앞서 세워 둔 것이 있으면 그 미리보기를 놓아준다.
      if (prev !== null) URL.revokeObjectURL(prev.preview);
      return { original: named, shrunk: null, preview, shrinkError: "" };
    });

    if (!isShrinkableImage(named.type)) {
      // HEIC·TIFF 등은 브라우저가 canvas 로 그리지 못한다. 원본으로만 올릴 수 있다.
      setStaged((prev) =>
        prev === null || prev.preview !== preview
          ? prev
          : { ...prev, shrinkError: "이 형식은 줄일 수 없습니다 — 원본으로만 올립니다." },
      );
      return;
    }

    void shrinkImage(named)
      .then((small) => {
        setStaged((prev) => {
          // 그 사이 다른 것을 붙여넣었으면 버린다.
          if (prev === null || prev.preview !== preview) return prev;
          // 줄인 것이 더 크면 줄이는 뜻이 없다(이미 작은 캡처). 원본만 남긴다.
          return small.size >= named.size ? prev : { ...prev, shrunk: small };
        });
      })
      .catch((problem: unknown) => {
        setStaged((prev) =>
          prev === null || prev.preview !== preview
            ? prev
            : {
                ...prev,
                shrinkError: problem instanceof Error ? problem.message : String(problem),
              },
        );
      });
  }

  /** 세워 둔 것을 치운다. 미리보기 주소를 반드시 놓아준다. */
  function clearStaged(): void {
    setStaged((prev) => {
      if (prev !== null) URL.revokeObjectURL(prev.preview);
      return null;
    });
  }

  async function uploadStaged(file: File): Promise<void> {
    clearStaged();
    await upload([file]);
  }

  /*
   * 창 전체에서 붙여넣기와 끌어다 놓기를 받는다.
   *
   * 입력칸에만 붙이면 답변칸에 포커스가 없을 때 아무 일도 일어나지 않는다 — 캡처를 찍고
   * 바로 Ctrl+V 하는 흐름이 가장 흔하다. 글 붙여넣기와 충돌하지 않는다: 클립보드에
   * 이미지 **파일**이 있을 때만 움직인다.
   *
   * dragover 를 막지 않으면 브라우저가 그 파일로 **페이지를 떠난다** — 쓰던 답변이
   * 사라진다. 그래서 막는 것 자체가 고침이다.
   */
  useEffect(() => {
    const imageFrom = (list: FileList | null | undefined): File | null => {
      for (const file of Array.from(list ?? [])) {
        if (file.type.startsWith("image/")) return file;
      }
      return null;
    };

    const onPaste = (event: ClipboardEvent): void => {
      if (busy) return;
      const image = imageFrom(event.clipboardData?.files);
      if (image === null) return;
      event.preventDefault();
      stage(image);
    };
    const onDragOver = (event: DragEvent): void => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
        event.preventDefault();
        setDragging(true);
      }
    };
    const onDragLeave = (): void => setDragging(false);
    const onDrop = (event: DragEvent): void => {
      const image = imageFrom(event.dataTransfer?.files);
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
      setDragging(false);
      if (busy || image === null) return;
      stage(image);
    };

    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, requestId, actorName]);

  // 화면을 떠날 때 미리보기 주소를 놓아준다.
  useEffect(() => () => {
    setStaged((prev) => {
      if (prev !== null) URL.revokeObjectURL(prev.preview);
      return null;
    });
  }, []);

  const title =
    `답변 전송과 별개로, 고르는 즉시 이 케이스에 파일이 올라갑니다. 여러 개를 한 번에 고를 수 있습니다`
    + ` (파일당 ${MAX_UPLOAD_LABEL} 이하). 화면 캡처는 Ctrl+V 로 붙여넣거나 창에 끌어다 놓으면`
    + ` 미리보기를 보고 올릴 수 있습니다.`;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        // 여러 개를 한 번에 고를 수 있다. 수집기가 브라우저 한 번으로 다 처리하므로
        // 하나씩 올리는 것보다 훨씬 빠르다.
        multiple
        // 올리는 동안은 이 칸도 같이 잠근다. 버튼만 잠그면 키보드로 여기에 포커스를 옮겨
        // 파일을 다시 고를 수 있고, 그러면 같은 파일이 두 번 올라간다 — 큐는 업로드를
        // 합쳐 주지 않는다(lib/attachmentJobs.ts 의 합치기는 다운로드에만 있다).
        disabled={busy}
        // 보이지 않게 두고 버튼이 대신 누른다. display:none 을 쓰지 않는 이유는
        // 일부 브라우저가 숨겨진 입력의 click() 을 무시하기 때문이다.
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          // 같은 파일을 다시 고를 수 있게 즉시 비운다(머리말 참고).
          event.target.value = "";
          if (picked.length > 0) void upload(picked);
        }}
      />
      <button
        type="button"
        title={title}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        style={{
          ...controlStyle,
          display: "inline-flex", alignItems: "baseline", gap: SPACE.xs,
          padding: `${SPACE.sm}px ${SPACE.md}px`, fontSize: TEXT.small, fontWeight: WEIGHT.semibold,
          color: busy ? COLOR.faint : COLOR.ink,
          background: busy ? COLOR.ground : COLOR.surface,
          cursor: busy ? "default" : "pointer", whiteSpace: "nowrap",
        }}
      >
        {busy
          ? `올리는 중… ${total > 1 ? `${total}개 ` : ""}${elapsed}초`
          : "파일 붙이기"}
        <span style={{ fontSize: TEXT.micro, fontWeight: WEIGHT.normal, color: COLOR.faint }}>
          {busy ? "그대로 기다리세요" : dragging ? "여기 놓으세요" : "붙여넣기 · 답변과 별개"}
        </span>
      </button>

      {/*
        붙여넣은 이미지. 버튼 줄의 다음 줄 전체를 쓴다(상태 문구와 같은 이유 — 아래 주석).
        order:1 로 그리는 순서만 뒤로 밀어 전송 버튼을 밀어내지 않게 한다.
      */}
      {staged !== null && (
        <div style={{
          flexBasis: "100%", minWidth: 0, order: 1,
          display: "flex", gap: SPACE.md, alignItems: "flex-start",
          background: COLOR.ground, borderRadius: RADIUS.control,
          padding: `${SPACE.md}px`, border: `1px solid ${COLOR.field}`,
        }}>
          {/* 무엇을 붙여넣었는지 보여 준다. 클립보드에 뭐가 있었는지 사람은 모른다. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={staged.preview}
            alt="붙여넣은 이미지"
            style={{
              width: 92, height: 92, objectFit: "cover", flexShrink: 0,
              borderRadius: RADIUS.control, border: `1px solid ${COLOR.line}`,
              background: COLOR.surface,
            }}
          />
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: SPACE.sm }}>
            <div style={{ fontSize: TEXT.small, color: COLOR.ink, wordBreak: "break-all" }}>
              <strong>{staged.original.name}</strong>
              <span style={{ color: COLOR.faint, marginLeft: SPACE.xs }}>
                {sizeText(staged.original.size)}
              </span>
            </div>
            <div style={{ display: "flex", gap: SPACE.sm, flexWrap: "wrap" }}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void uploadStaged(staged.original)}
                style={{
                  ...controlStyle, padding: `${SPACE.xs}px ${SPACE.md}px`, fontSize: TEXT.small,
                  fontWeight: WEIGHT.semibold, cursor: busy ? "default" : "pointer",
                }}
              >
                원본으로 올리기
              </button>
              {/*
                줄인 것이 준비됐을 때만 내준다. 누른 뒤에 줄이면 그 몇 초 동안 화면이
                조용하고, 크기도 적어 줄 수 없다 — 그러면 고를 근거가 없다.
              */}
              {staged.shrunk !== null && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void uploadStaged(staged.shrunk as File)}
                  style={{
                    ...controlStyle, padding: `${SPACE.xs}px ${SPACE.md}px`, fontSize: TEXT.small,
                    cursor: busy ? "default" : "pointer",
                  }}
                >
                  {`줄여서 올리기 (${sizeText(staged.shrunk.size)})`}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={clearStaged}
                style={{
                  ...controlStyle, padding: `${SPACE.xs}px ${SPACE.md}px`, fontSize: TEXT.small,
                  color: COLOR.muted, cursor: busy ? "default" : "pointer",
                }}
              >
                취소
              </button>
            </div>
            <div style={{ fontSize: TEXT.micro, color: COLOR.faint, lineHeight: 1.6 }}>
              {staged.shrinkError !== ""
                ? staged.shrinkError
                : staged.shrunk === null
                  // 줄이는 중이거나, 줄여도 더 크던 경우다. 둘 다 원본이 답이다.
                  ? "크기를 줄여 보는 중입니다…"
                  : "글자가 작은 캡처라면 원본으로 올리세요 — 줄이면 읽기 어려워질 수 있습니다."}
            </div>
          </div>
        </div>
      )}

      {/*
        상태 문구는 버튼 줄의 **다음 줄 전체**를 쓴다(flexBasis 100%). 부모는 wrap 되는
        flex 줄이라, 문장을 버튼들 사이에 끼우면 긴 실패 메시지가 전송 버튼을 밀어내고
        좁은 화면에서 줄이 엉킨다. 한 줄을 통째로 차지하면 1440·760 둘 다 안 흔들린다.

        order:1 이 필요한 이유 — 이 문구는 DOM 상 파일 붙이기 버튼 바로 뒤에 있어서,
        그대로 두면 문구가 번역·정리·전송 **사이를 갈라** 전송 버튼을 아래로 밀어낸다.
        사람이 전송을 누르려는 순간 버튼이 내려가면 안 된다. 그래서 그리는 순서만 뒤로 민다.
      */}
      {(busy || note !== "" || error !== "" || warn !== "") && (
        <div
          role="status"
          style={{
            flexBasis: "100%", minWidth: 0, order: 1,
            fontSize: TEXT.micro, lineHeight: 1.6, wordBreak: "break-word",
            color: error !== "" ? COLOR.waitUs : warn !== "" ? COLOR.warn : busy ? COLOR.muted : COLOR.ok,
            background: error !== "" ? COLOR.waitUsBg : warn !== "" ? COLOR.warnBg : "transparent",
            border: error !== ""
              ? "1px solid #f3c7c2"
              : warn !== "" ? "1px solid #f3dca8" : "1px solid transparent",
            borderRadius: RADIUS.control,
            padding: error !== "" || warn !== "" ? "8px 11px" : "2px 2px 0",
          }}
        >
          {error !== ""
            ? error
            : busy
              // 수집기가 집어가는 데 최대 15초, 브라우저 진입에 10초가 더 든다.
              ? `수집기가 브라우저로 ${total > 1 ? `${total}개를 함께 ` : ""}올립니다. 1분 가까이 걸릴 수 있습니다 — 다시 누르지 마세요.`
              // 올렸다는 말과 확인 못 했다는 말을 **한 줄에** 붙여 둔다. 둘을 떼어 놓으면
              // 경고만 읽고 실패로 오해해 다시 올린다.
              : warn !== "" ? `${note} ${warn}` : note}
        </div>
      )}
    </>
  );
}

/** 사람이 읽을 크기. KB 아래는 적을 이유가 없다. */
function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
