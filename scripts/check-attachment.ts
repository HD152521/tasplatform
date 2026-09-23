/**
 * 첨부를 서버가 직접 받아올 수 있는지 확인한다.
 *
 * 첨부가 "Broadcom 으로 튕기는지 / 그대로 받아지는지" 는 **살아 있는 세션**이 있어야
 * 알 수 있다. 화면에서 눌러 보면 실패했을 때 무엇이 막혔는지 안 보이므로, 같은 경로를
 * 그대로 따라가며 단계마다 결과를 찍는다.
 *
 * 세션이 있는 곳에서 돌린다(보통 수집기 VM):
 *   node scripts/check-attachment.ts            가장 작은 첨부로 시험
 *   node scripts/check-attachment.ts 17664657   특정 첨부로 시험
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CookieJar } from "../collector/cookieJar.ts";
import { API_HEADERS, API_ORIGIN, DEFAULT_TEAM_ID, sessionFileForTeam } from "../lib/config.ts";
import { isAllowedHost, resolveAttachmentUrl } from "../lib/attachmentSource.ts";
import { isAttachmentHost } from "../lib/attachmentWarmup.ts";
import { openDb } from "../lib/db.ts";

const MAX_HOPS = 8;

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(16)} ${value}`);
}

async function main(): Promise<void> {
  const wanted = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 0);

  const db = await openDb();
  const doc = wanted > 0
    ? await db.get<{ document_id: number; doc_name: string; doc_path: string; content_type: string }>(
      "SELECT document_id, doc_name, doc_path, content_type FROM attachments WHERE document_id = ?",
      [wanted],
    )
    : await db.get<{ document_id: number; doc_name: string; doc_path: string; content_type: string }>(
      `SELECT document_id, doc_name, doc_path, content_type FROM attachments
        WHERE doc_path <> '' ORDER BY file_size ASC LIMIT 1`,
    );
  await db.close();

  if (doc === undefined) {
    console.error("첨부를 찾지 못했습니다.");
    process.exitCode = 1;
    return;
  }

  console.log("[1] 첨부");
  line("id", String(doc.document_id));
  line("이름", doc.doc_name);
  line("저장 타입", doc.content_type || "(없음)");

  console.log("\n[2] 원본 주소 해석");
  const source = resolveAttachmentUrl(doc.doc_path, API_ORIGIN);
  if (source === null) {
    line("결과", "✗ 허용 호스트가 아님 — lib/attachmentSource.ts 를 봐야 한다");
    line("doc_path", doc.doc_path.slice(0, 100));
    process.exitCode = 1;
    return;
  }
  line("결과", "✓ 통과");
  line("호스트", new URL(source).hostname);

  console.log("\n[3] 세션 쿠키");
  const sessionFile = resolve(sessionFileForTeam(DEFAULT_TEAM_ID));
  if (!existsSync(sessionFile)) {
    line("결과", `✗ 세션 파일이 없다: ${sessionFile}`);
    process.exitCode = 1;
    return;
  }
  const jar = CookieJar.fromFile(sessionFile);
  const warmed = jar.snapshot().some(
    (c) => isAttachmentHost(c.domain) && !/^auth_(nonce|redir)$/i.test(c.name),
  );
  line("첨부 호스트 쿠키", warmed ? "✓ 있음 (로그인 때 예열됨)" : "✗ 없음 — 예열이 안 됐다");

  console.log("\n[4] 실제로 받아오기");
  let url = source;
  let response: Response | null = null;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const at = new URL(url);
    const cookie = jar.header(at);
    response = await fetch(url, {
      headers: { ...API_HEADERS, ...(cookie === "" ? {} : { Cookie: cookie }) },
      redirect: "manual",
    });
    jar.apply(response.headers.getSetCookie(), at);
    const location = response.headers.get("location");
    line(`hop ${hop + 1}`, `${response.status} ${at.hostname}${location === null ? "" : " → " + new URL(location, at).hostname}`);
    if (response.status < 300 || response.status >= 400 || location === null) break;
    const next = new URL(location, at);
    if (!isAllowedHost(next.hostname)) {
      line("중단", `허용하지 않는 호스트로 보냄: ${next.hostname}`);
      break;
    }
    url = next.toString();
  }

  console.log("\n[5] 판정");
  if (response === null) {
    line("결과", "✗ 응답 없음");
    process.exitCode = 1;
    return;
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const size = response.headers.get("content-length") ?? "(모름)";
  line("최종 상태", String(response.status));
  line("타입", type || "(없음)");
  line("길이", size);

  if (response.ok && !type.includes("text/html")) {
    console.log("\n  ✓ 서버가 파일을 직접 받아올 수 있다. 화면에서 누르면 그대로 받아진다.");
    return;
  }
  console.log("\n  ✗ 파일이 아니라 로그인 화면이 돌아왔다. 첨부는 Broadcom 으로 넘어간다.");
  console.log(warmed
    ? "    예열 쿠키는 있으나 통하지 않는다 — supportftp 가 따로 인증을 요구하는지 봐야 한다."
    : "    로그인 때 예열이 안 됐다. 최신 코드로 다시 `npm run refresh` 를 해 보라.");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("확인 실패:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
