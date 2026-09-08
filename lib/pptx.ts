/**
 * 정기점검 보고서 PPTX 만들기.
 *
 * 값을 모아 JSON 으로 넘기고, 실제 파일 조작은 scripts/build_report.py 가 한다.
 * 파이썬을 쓰는 이유는 그 스크립트 주석에 적어 두었다 (한 칸이 48조각으로
 * 쪼개져 있어 문자열 치환이 안 된다).
 *
 * 양식은 templates/monthly-report.pptx 를 그대로 쓴다. 디자인은 손대지 않는다.
 */
import "server-only";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atlassianConfig } from "./atlassian.ts";
import { calculateInstances } from "./instanceCount.ts";
import { loadMonth, resolvePrevious } from "./instanceStore.ts";
import { fetchMonthlyWork } from "./jira.ts";
import { listCasesInMonth } from "./queries.ts";
import { loadPicks } from "./reportPicks.ts";
import { getSrReport } from "./srReport.ts";
import { normalizeAnalysis, severityDigit, statusLabel } from "./srReportFormat.ts";

export class ReportBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportBuildError";
  }
}

const TEMPLATE = "templates/monthly-report.pptx";
const SCRIPT = "scripts/build_report.py";

/** 1,515 처럼 천 단위만 끊는다. 소수는 한 자리까지. */
function num(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : String(Math.round(value * 10) / 10);
}

function signed(value: number): string {
  if (value === 0) return "0";
  return value > 0 ? `+${num(value)}` : num(value);
}

/** '02-August-2026 ...' → '2026-08-02'. 실패하면 원문 앞부분을 그대로 둔다. */
function isoDate(raw: string): string {
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    const d = new Date(parsed);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return raw.slice(0, 11);
}

export interface BuildProgress {
  step: string;
  done: number;
  total: number;
}

/**
 * 보고서 한 부를 만든다.
 *
 * SR 정리는 AI 를 부르므로 건수만큼 시간이 걸린다. 저장된 것이 있으면 재사용한다.
 * 반환은 만들어진 pptx 의 바이트다.
 */
export async function buildMonthlyReport(
  month: string,
  onProgress?: (p: BuildProgress) => void,
): Promise<{ bytes: Buffer; fileName: string; srCount: number; workCount: number }> {
  if (!existsSync(TEMPLATE)) {
    throw new ReportBuildError(`양식 파일이 없습니다: ${TEMPLATE}`);
  }

  // 1) 클라우드 운영 현황
  const saved = loadMonth(month);
  if (saved === null) {
    throw new ReportBuildError("1단계 인스턴스 수가 저장되어 있지 않습니다.");
  }
  const previous = resolvePrevious(month);
  const instances = calculateInstances(saved.input, previous.values);

  // 2) SR — 고른 것만
  const pickedSr = new Set(loadPicks(month, "sr"));
  const cases = listCasesInMonth(month).filter((c) => pickedSr.has(String(c.request_id)));
  if (cases.length === 0) {
    throw new ReportBuildError("2단계에서 고른 SR 이 없습니다.");
  }

  const srs: Array<Record<string, string>> = [];
  for (const [index, c] of cases.entries()) {
    onProgress?.({ step: `SR 정리 ${c.request_id_formatted}`, done: index, total: cases.length });
    const report = await getSrReport(c.request_id);
    srs.push({
      no: c.request_id_formatted,
      openedOn: isoDate(c.created_on),
      closedOn: isoDate(c.last_updated),
      title: report.title !== "" ? report.title : c.subject,
      progress: report.result,
      done: statusLabel(c.status),
      product: c.category !== "" ? c.category : "Tanzu Application Service",
      severity: severityDigit(c.priority),
      status: statusLabel(c.status),
      symptom: report.title !== "" ? report.title : c.subject,
      analysis: normalizeAnalysis(report.analysis),
      result: report.result,
    });
  }

  // 3) 작업 진행 현황 — 고른 것만
  onProgress?.({ step: "Jira 작업 내역", done: cases.length, total: cases.length });
  const config = atlassianConfig();
  let work: Array<Record<string, string>> = [];
  if (config !== null && config.jiraProject !== "") {
    const pickedWork = new Set(loadPicks(month, "jira"));
    const fetched = await fetchMonthlyWork(config, month);
    const rows = pickedWork.size > 0
      ? fetched.rows.filter((r) => pickedWork.has(r.key))
      : fetched.rows;
    work = rows.map((r) => ({
      center: r.center,
      corp: r.corp,
      span: r.span,
      support: r.support,
      title: r.title,
      issue: r.issue,
      note: r.note,
    }));
  }

  const payload = {
    template: TEMPLATE,
    monthLabel: `${month.slice(5)}월`,
    cloud: {
      rows: instances.rows.map((r) => ({
        container: num(r.container),
        note: r.note.replace(/\s{2,}/g, "\n"),
        delta: signed(r.delta),
      })),
      total: {
        cluster: num(instances.total.cluster),
        host: num(instances.total.host),
        container: num(instances.total.container),
        delta: signed(instances.total.delta),
      },
    },
    // 2-1 라이선스 현황 중 TAS App Service 행의 "실 운영 현황" 세 칸만 갱신한다.
    // 나머지 칸과 다른 제품 행은 양식 그대로 둔다.
    license: {
      bank: num(instances.actual.bank),
      central: num(instances.actual.central),
      total: num(instances.actual.total),
    },
    srs,
    work,
  };

  // 4) 파이썬으로 넘긴다
  const dir = await mkdtemp(join(tmpdir(), "sr-report-"));
  const inPath = join(dir, "payload.json");
  const outPath = join(dir, "report.pptx");
  try {
    await writeFile(inPath, JSON.stringify(payload), "utf8");
    await runPython([SCRIPT, inPath, outPath]);
    const bytes = await readFile(outPath);
    return {
      bytes,
      fileName: `${month.replace("-", "년_")}월_정기점검_보고서.pptx`,
      srCount: srs.length,
      workCount: work.length,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 파이썬 실행. 실패하면 표준오류를 그대로 올린다 — 조용히 삼키지 않는다. */
function runPython(args: string[]): Promise<void> {
  const exe = process.env.SR_PYTHON
    ?? (existsSync(".venv/Scripts/python.exe") ? ".venv/Scripts/python.exe" : "python");

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      reject(new ReportBuildError(`파이썬 실행 실패 (${exe}): ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new ReportBuildError(`보고서 생성 실패 (종료코드 ${code})\n${stderr.slice(-800)}`));
    });
  });
}
