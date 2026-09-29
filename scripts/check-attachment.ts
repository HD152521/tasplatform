/**
 * 첨부를 받아올 수 있는지 확인한다. **브라우저가 있는 기계에서 돌린다**(수집기 VM).
 *
 * 첨부는 supportftp(CrushFTP)에 있고, 그 로그인은 redirect.html 이 JS 로 이동시켜
 * 끝난다 — fetch 로는 인증 자체가 안 된다(lib/crushftp.ts 머리말). 그래서 여기서도
 * 실제 처리와 똑같이 브라우저로 들어가 단계마다 결과를 찍는다.
 *
 * 화면에서 눌러 보면 실패했을 때 무엇이 막혔는지 안 보인다. 특히 이 셋이 전혀 다른데
 * 겉으로는 똑같이 "안 받아짐" 으로 보인다:
 *
 *   403  오래된 케이스라 첨부가 닫혔다      → 사람이 할 수 있는 게 없다
 *   404  파일이 서버에서 지워졌다            → 담당자에게 다시 요청해야 한다
 *   HTML 로그인이 안 끝났다                  → 세션을 다시 만들어야 한다
 *
 *   node scripts/check-attachment.ts            진행중 케이스의 가장 작은 첨부로
 *   node scripts/check-attachment.ts 17664657   특정 첨부로
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { launchBrowser } from "../collector/session.ts";
import { CookieJar } from "../collector/cookieJar.ts";
import { API_HEADERS, DEFAULT_TEAM_ID, NAV_TIMEOUT_MS, sessionFileForTeam } from "../lib/config.ts";
import { FTP_ORIGIN, boundCaseOf, c2fFrom, fileUrlFor, parseFilePath } from "../lib/crushftp.ts";
import { openDb } from "../lib/db.ts";
import { hydrateTeamSessionFromDb } from "../lib/sessionStore.ts";

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(16)} ${value}`);
}

interface Doc {
  document_id: number;
  request_id: number;
  doc_name: string;
  doc_path: string;
  status: string;
}

async function main(): Promise<void> {
  const wanted = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 0);

  const db = await openDb();
  await hydrateTeamSessionFromDb(DEFAULT_TEAM_ID, db);
  const doc = wanted > 0
    ? await db.get<Doc>(
      `SELECT a.document_id, a.request_id, a.doc_name, a.doc_path, c.status
         FROM attachments a LEFT JOIN cases c ON c.request_id = a.request_id
        WHERE a.document_id = ?`,
      [wanted],
    )
    : await db.get<Doc>(
      `SELECT a.document_id, a.request_id, a.doc_name, a.doc_path, c.status
         FROM attachments a JOIN cases c ON c.request_id = a.request_id
        WHERE a.doc_path <> '' AND a.file_size > 0 AND c.status NOT LIKE '%Closed%'
        ORDER BY a.file_size ASC LIMIT 1`,
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
  line("케이스", `${doc.request_id} (${doc.status || "상태 모름"})`);

  console.log("\n[2] 주소 읽기");
  const ref = parseFilePath(doc.doc_path);
  if (ref === null) {
    line("결과", "✗ filePath 를 읽지 못했습니다");
    line("doc_path", doc.doc_path.slice(0, 110));
    process.exitCode = 1;
    return;
  }
  line("결과", "✓ 통과");
  line("고객사/케이스", `${ref.site} / ${ref.caseId}`);
  line("받을 주소", fileUrlFor(ref).slice(0, 96));

  const sessionFile = resolve(sessionFileForTeam(DEFAULT_TEAM_ID));
  console.log("\n[3] 세션 파일");
  if (!existsSync(sessionFile)) {
    line("결과", `✗ 없습니다: ${sessionFile}`);
    process.exitCode = 1;
    return;
  }
  line("경로", sessionFile);

  console.log("\n[4] 브라우저로 케이스 진입");
  const browser = await launchBrowser(true);
  try {
    const context = await browser.newContext({ storageState: sessionFile });
    try {
      const page = await context.newPage();
      const started = Date.now();
      await page.goto(`${FTP_ORIGIN}/WebInterface/redirect.html?site=${ref.site}&case=${ref.caseId}`, {
        waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS,
      });
      line("걸린 시간", `${((Date.now() - started) / 1000).toFixed(1)}초`);
      line("도착한 곳", page.url().slice(0, 80));
      await page.close().catch(() => undefined);

      const jar = new CookieJar((await context.cookies()) as never);
      let c2f = "";
      try {
        c2f = c2fFrom(jar);
      } catch {
        line("c2f", "✗ CrushAuth 쿠키가 없습니다 — 로그인이 안 끝났습니다");
      }

      if (c2f !== "") {
        const form = new FormData();
        form.append("command", "getUsername");
        form.append("c2f", c2f);
        form.append("random", String(Math.random()));
        const url = new URL(`${FTP_ORIGIN}/WebInterface/function/`);
        const response = await fetch(url, {
          method: "POST",
          headers: { ...API_HEADERS, Cookie: jar.header(url) },
          body: form,
        });
        const xml = await response.text();
        const ok = /<response>\s*success\s*<\/response>/i.test(xml);
        line("로그인", ok ? "✓ 끝났습니다" : "✗ 안 끝났습니다 — 세션을 다시 만들어야 합니다");
        const bound = boundCaseOf(xml);
        line(
          "묶인 케이스",
          bound === null ? "(없음)" : bound === ref.caseId ? `✓ ${bound}` : `✗ ${bound} (원하는 건 ${ref.caseId})`,
        );
      }

      console.log("\n[5] 파일 받기");
      const file = await context.request.get(fileUrlFor(ref), { timeout: 60_000 });
      const type = (file.headers()["content-type"] ?? "").toLowerCase();
      line("상태", String(file.status()));
      line("타입", type || "(없음)");

      console.log("\n[6] 판정");
      if (file.status() === 403) {
        console.log("\n  ✗ 이 케이스의 첨부가 닫혀 있습니다(403).");
        console.log("    오래된·종료된 케이스에서 그렇습니다. 진행중 케이스로 다시 확인해 보세요:");
        console.log("      node scripts/check-attachment.ts");
        process.exitCode = 1;
        return;
      }
      if (file.status() === 404) {
        console.log("\n  ✗ 파일이 서버에 없습니다(404).");
        console.log("    Broadcom 이 오래된 업로드를 치웁니다. 우리 DB 에만 남아 있는 첨부입니다.");
        process.exitCode = 1;
        return;
      }
      if (!file.ok()) {
        console.log(`\n  ✗ 첨부 서버가 거부했습니다 (HTTP ${file.status()}).`);
        process.exitCode = 1;
        return;
      }
      if (type.includes("text/html")) {
        console.log("\n  ✗ 파일이 아니라 로그인 화면이 왔습니다. 세션을 다시 만들어야 합니다:");
        console.log("      npm run refresh");
        process.exitCode = 1;
        return;
      }
      const body = await file.body();
      line("길이", `${body.byteLength}B`);
      console.log("\n  ✓ 받아집니다. 화면에서 눌러도 그대로 받아집니다.");
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error("확인 실패:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
