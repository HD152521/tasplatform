import { COLOR } from "../ui.tsx";
import { listCasesInMonth } from "../../lib/queries.ts";
import { listMonths, loadMonth, previousMonthOf, resolvePrevious } from "../../lib/instanceStore.ts";
import { countPicks, loadPicks } from "../../lib/reportPicks.ts";
import { InstanceForm } from "./InstanceForm.tsx";
import MonthPicker from "./MonthPicker.tsx";
import { BuildStep } from "./BuildStep.tsx";
import { JiraWork } from "./JiraWork.tsx";
import { SrPicker } from "./SrPicker.tsx";
import { STEPS, StepNav, Stepper } from "./Stepper.tsx";

export const dynamic = "force-dynamic";

/** 이번 달의 직전 달. 보고서는 지난달 실적을 쓰므로 기본값으로 둔다. */
function defaultMonth(): string {
  const now = new Date();
  return previousMonthOf(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
}

function readStep(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= STEPS.length ? n : 1;
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; step?: string }>;
}) {
  const params = await searchParams;
  const month = params.month ?? defaultMonth();
  const step = readStep(params.step);
  const counts = await countPicks(month);
  const label = `${month.replace("-", "년 ")}월`;
  const jiraInitial = step === 3 ? await loadPicks(month, "jira") : [];
  const hasInstances = step === 4 ? (await loadMonth(month)) !== null : false;
  // 월 선택은 머리말에 둔다 — 예전엔 1단계 안에만 있어서 다른 단계에서 못 바꿨다.
  const savedMonths = (await listMonths()).map((m) => m.month);

  return (
    <>
      <header style={{
        marginBottom: 18, display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", gap: 16, flexWrap: "wrap",
      }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
            정기점검 보고서
          </h1>
          <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted }}>
            {`${label} · ${STEPS[step - 1]?.note ?? ""}`}
          </p>
        </div>
        <MonthPicker month={month} step={step} savedMonths={savedMonths} />
      </header>

      <Stepper month={month} step={step} counts={counts} />

      {step === 1 && <StepInstances month={month} />}
      {step === 2 && <StepSr month={month} />}
      {step === 3 && <JiraWork month={month} initial={jiraInitial} />}
      {step === 4 && (
        <BuildStep
          month={month}
          srCount={counts.sr}
          workCount={counts.jira}
          hasInstances={hasInstances}
        />
      )}

      <StepNav month={month} step={step} />
    </>
  );
}

async function StepInstances({ month }: { month: string }) {
  const saved = await loadMonth(month);
  const previous = await resolvePrevious(month);
  return (
    <InstanceForm
      month={month}
      savedInput={saved?.input ?? null}
      previous={previous.values}
      previousMonth={previous.fromMonth}
    />
  );
}

async function StepSr({ month }: { month: string }) {
  const cases = await listCasesInMonth(month);
  const initial = await loadPicks(month, "sr");
  return <SrPicker month={month} cases={cases} initial={initial} />;
}
