/**
 * 첨부 작업 한 건이 어떻게 끝났는지 본다.
 *
 * 화면은 실패 사유를 한 줄로만 보여주고, 그 줄은 작업 행(attachment_jobs.error)에서
 * 온다. **그 행을 읽을 방법이 없었다** — 2026-11-17 에 첨부 한 건이
 * `KakaoTalk_….jpg: fetch failed` 로 끝났을 때, 그 넉 자가 어느 단계에서 나왔는지
 * 확인하려고 cf ssh 로 들어가 psql 을 찾는 수밖에 없었다. 그래서 한 줄로 만들었다.
 *
 * scripts/check-attachment.ts 와 다르다 — 그쪽은 **받아오기**를 브라우저로 재보는
 * 도구이고(document_id 를 받는다), 이쪽은 **큐에 적힌 결과**를 읽는다(job_id).
 *
 *   node scripts/check-job.ts            최근 10건
 *   node scripts/check-job.ts 33         그 번호 한 건
 *   node scripts/check-job.ts --failed   실패한 것만
 *
 * 올린 파일 내용(payload)은 찍지 않는다. 고객 파일이고, 여기서 알고 싶은 것도 아니다.
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { openDb } from "../lib/db.ts";

interface Row {
  job_id: number;
  kind: string;
  request_id: number;
  file_name: string;
  state: string;
  error: string;
  actor: string;
  team_id: string;
  created_at: string;
  updated_at: string;
  /** payload 를 가져오지 않고 길이만 센다 — 사본이 남아 있는지는 알아야 한다. */
  payload_len: number;
}

const COLUMNS =
  "job_id, kind, request_id, file_name, state, error, actor, team_id, created_at, updated_at, "
  + "LENGTH(payload) AS payload_len";

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(12)} ${value}`);
}

/** 걸린 시간. 큐에 들어간 뒤 끝나기까지 얼마나 걸렸나. */
function took(row: Row): string {
  const started = Date.parse(row.created_at);
  const ended = Date.parse(row.updated_at);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return "(알 수 없음)";
  return `${((ended - started) / 1000).toFixed(1)}초`;
}

/**
 * 한 건을 풀어 쓴다.
 *
 * state 와 error 를 같이 보는 것이 요점이다 — **done 인데 error 가 있으면 실패가 아니라
 * 경고**다(올렸지만 폴더 확인을 못 한 경우. lib/attachmentJobs.ts finishJob 머리말).
 * 그걸 모르고 보면 "성공인데 오류가 있다" 로 읽혀 조사가 엉뚱한 데로 간다.
 */
function show(row: Row): void {
  const warned = row.state === "done" && row.error !== "";
  const mark = row.state === "failed" ? "✗" : warned ? "△" : row.state === "done" ? "✓" : "…";
  console.log(`\n${mark} #${row.job_id} ${row.kind} ${row.file_name || "(이름 없음)"}`);
  line("케이스", String(row.request_id));
  line("상태", warned ? "done (확인 못 함)" : row.state);
  line("올린 사람", `${row.actor || "(없음)"}${row.team_id === "" ? "" : ` / ${row.team_id}`}`);
  line("넣은 시각", row.created_at);
  line("끝난 시각", `${row.updated_at} (${took(row)})`);
  line("사본", row.payload_len > 0 ? `${row.payload_len}자(base64)` : "없음");
  if (row.error !== "") line(warned ? "경고" : "사유", row.error);
  if (row.state === "failed" && /^fetch failed$/.test(row.error)) {
    // 이 문구가 보이면 lib/fetchFailure.ts 가 들어가기 전에 남은 행이다.
    console.log("\n    ※ 사유가 \"fetch failed\" 뿐이라면 옛 코드가 남긴 행입니다.");
    console.log("      지금은 cause 를 풀어 적습니다(lib/fetchFailure.ts). 다시 올려 보세요.");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wanted = Number(args.find((a) => /^\d+$/.test(a)) ?? 0);
  const onlyFailed = args.includes("--failed");

  const db = await openDb();
  try {
    if (wanted > 0) {
      const row = await db.get<Row>(
        `SELECT ${COLUMNS} FROM attachment_jobs WHERE job_id = ?`,
        [wanted],
      );
      if (row === undefined) {
        console.error(`#${wanted} 을 찾지 못했습니다. 보관 기간이 지나 치워졌을 수 있습니다.`);
        process.exitCode = 1;
        return;
      }
      show(row);
      return;
    }

    const where = onlyFailed ? "WHERE state = 'failed'" : "";
    const rows = (await db.all<Row>(
      `SELECT ${COLUMNS} FROM attachment_jobs ${where} ORDER BY job_id DESC LIMIT 10`,
    )) as Row[];
    if (rows.length === 0) {
      console.log(onlyFailed ? "실패한 작업이 없습니다." : "작업 행이 없습니다.");
      return;
    }
    console.log(`최근 ${rows.length}건${onlyFailed ? " (실패만)" : ""}`);
    for (const row of rows) show(row);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error("확인 실패:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
