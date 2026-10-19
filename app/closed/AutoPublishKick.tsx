"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { COLOR, RADIUS } from "../ui.tsx";

/**
 * 자동 게시를 한 번 깨운다.
 *
 * ## 왜 화면이 부르나
 *
 * 올리는 일은 웹이 해야 하는데(게시 모듈이 server-only 다), 웹은 **스스로 깨어나지
 * 않는다.** 요청이 와야 코드가 돈다. 이 자리가 그 요청이다 — 완료 목록을 열면 한 번
 * 묻는다. 바깥에서 들어오는 길도, 수집기 VM 에서 이 주소가 닿는지 확인할 것도 없다.
 *
 * 서버 컴포넌트에서 불을 질러 놓고(fire-and-forget) 응답을 끝내는 방식은 쓰지 않는다 —
 * TAS 가 응답 뒤의 작업을 죽일 수 있다. 그래서 **클라이언트가 부르고 기다린다.**
 *
 * 단점은 아무도 앱을 안 열면 미뤄지는 것이다. 매일 쓰는 도구라 실제로는 문제되지 않고,
 * 수집기 VM 에서 이 주소가 닿으면 수집 뒤 `curl` 로도 걸 수 있다(둘이 겹쳐도 "올렸다"
 * 표시가 자물쇠라 두 번 올라가지 않는다).
 *
 * ## 조용히 있는다
 *
 * 올릴 것이 없으면 **아무것도 그리지 않는다.** 매번 여는 화면이라 "0건 처리" 같은 줄이
 * 남으면 눈에 거슬리고, 그러면 사람이 그 자리를 안 보게 된다. 올렸거나 실패했을 때만
 * 말한다 — 실패를 조용히 넘기면 자동 기능이 멈춘 것을 아무도 모른다.
 */
interface Result {
  state?: string;
  published?: number;
  failed?: number;
  /** 티켓에 결과를 남긴 건수. 게시와 **따로** 센다 — 둘 중 하나만 실패할 수 있다. */
  commented?: number;
  commentFailed?: number;
  details?: {
    failed?: Array<{ caseLabel: string; message: string }>;
    commentFailed?: Array<{ caseLabel: string; message: string }>;
  };
}

export function AutoPublishKick() {
  const router = useRouter();
  const [result, setResult] = useState<Result | null>(null);
  /** 서버가 아예 실패한 경우. 조용히 넘기면 기능이 죽은 줄 아무도 모른다. */
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/autopublish", { method: "POST" });
        const data = (await response.json().catch(() => ({}))) as Result & {
          ok?: boolean; message?: string;
        };
        if (cancelled) return;

        /*
         * **서버가 실패했으면 말한다.**
         *
         * 전에는 `ok !== true` 면 조용히 돌아갔다. 그러면 자동 게시가 영구히 죽어도
         * 화면에는 아무 신호가 없고 서버 로그에만 남는다 — 아무도 로그를 안 본다.
         * 실제로 일어날 수 있는 경로가 있다: Postgres 에서 `publish_tries` 컬럼
         * 추가(ALTER)가 권한 때문에 실패하면 대상 조회가 매번 던진다(lib/db.ts 의
         * migrate 는 ALTER 실패를 로그만 남기고 넘어간다).
         */
        if (data.ok !== true) {
          setError(data.message ?? `자동 게시를 돌리지 못했습니다 (HTTP ${response.status}).`);
          return;
        }
        // 올린 것이 있으면 목록을 다시 읽는다 — 정리본 배지가 그 자리에서 바뀐다.
        if ((data.published ?? 0) > 0) {
          setResult(data);
          router.refresh();
          return;
        }
        // 게시는 0 건이어도 댓글이 실패했으면 말한다.
        if ((data.failed ?? 0) > 0 || (data.commentFailed ?? 0) > 0) setResult(data);
      } catch (problem) {
        // 망 오류는 흔하고 다음에 열 때 다시 부른다. 화면을 어지럽히지 않되 흔적은 남긴다.
        console.error("[autopublish] 깨우기 실패", problem);
      }
    })();

    return () => { cancelled = true; };
    // 한 번만 부른다. router 를 의존성에 넣으면 refresh 가 다시 이 효과를 돌린다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error !== "") {
    return (
      <div style={{
        marginBottom: 14, padding: "10px 13px", fontSize: 12.5, lineHeight: 1.6,
        color: COLOR.waitUs, background: COLOR.waitUsBg,
        border: "1px solid #f3c7c2", borderRadius: RADIUS.control,
      }}>
        {`끝난 SR 의 자동 게시가 돌지 않았습니다 — ${error} 케이스를 열어 직접 올릴 수 있습니다.`}
      </div>
    );
  }

  if (result === null) return null;

  const published = result.published ?? 0;
  const failed = result.failed ?? 0;
  const warn = failed > 0 || (result.commentFailed ?? 0) > 0;
  const tone = warn ? COLOR.warn : COLOR.ok;

  return (
    <div style={{
      marginBottom: 14, padding: "10px 13px", fontSize: 12.5, lineHeight: 1.6,
      color: tone, background: warn ? COLOR.warnBg : COLOR.okBg,
      border: `1px solid ${warn ? "#f0d69a" : "#b9e6cd"}`,
      borderRadius: RADIUS.control,
    }}>
      {published > 0 && (
        <div>
          {`끝난 SR ${published}건의 정리 문서를 Confluence 에 올렸습니다.`}
          {(result.commented ?? 0) > 0 && ` Jira 티켓 ${result.commented}건에 결과를 남겼습니다.`}
        </div>
      )}
      {/*
        **게시는 됐는데 댓글만 실패한 경우를 구분해 말한다.** 뭉쳐서 "실패" 라고 하면
        사람이 문서를 다시 올리려 하는데, 문서는 이미 올라가 있다.
      */}
      {(result.commentFailed ?? 0) > 0 && (
        <div style={{ marginTop: published > 0 ? 4 : 0 }}>
          {`문서는 올렸지만 Jira 티켓 ${result.commentFailed}건에는 결과를 남기지 못했습니다 — `}
          {(result.details?.commentFailed ?? []).map((f) => `${f.caseLabel}: ${f.message}`).join(" / ")}
        </div>
      )}
      {failed > 0 && (
        <div>
          {`${failed}건은 올리지 못했습니다 — `}
          {(result.details?.failed ?? []).map((f) => `${f.caseLabel}: ${f.message}`).join(" / ")}
          {" 케이스를 열어 직접 올릴 수 있습니다."}
        </div>
      )}
    </div>
  );
}
