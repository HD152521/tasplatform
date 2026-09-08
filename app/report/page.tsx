import { COLOR } from "../ui.tsx";
import { listCasesInMonth } from "../../lib/queries.ts";
import { listMonths, loadMonth, previousMonthOf, resolvePrevious } from "../../lib/instanceStore.ts";
import { countPicks, loadPicks } from "../../lib/reportPicks.ts";
import { InstanceForm } from "./InstanceForm.tsx";
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
  const counts = countPicks(month);
  const label = `${month.replace("-", "년 ")}월`;

  return (
    <>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          정기점검 보고서
        </h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted }}>
          {`${label} · ${STEPS[step - 1]?.note ?? ""}`}
        </p>
      </header>

      <Stepper month={month} step={step} counts={counts} />

      {step === 1 && <StepInstances month={month} />}
      {step === 2 && <StepSr month={month} />}
      {step === 3 && <JiraWork month={month} initial={loadPicks(month, "jira")} />}
      {step === 4 && (
        <BuildStep
          month={month}
          srCount={counts.sr}
          workCount={counts.jira}
          hasInstances={loadMonth(month) !== null}
        />
      )}

      <StepNav month={month} step={step} />
    </>
  );
}

function StepInstances({ month }: { month: string }) {
  const saved = loadMonth(month);
  const previous = resolvePrevious(month);
  return (
    <InstanceForm
      month={month}
      savedInput={saved?.input ?? null}
      previous={previous.values}
      previousMonth={previous.fromMonth}
      savedMonths={listMonths()}
    />
  );
}

function StepSr({ month }: { month: string }) {
  return (
    <SrPicker month={month} cases={listCasesInMonth(month)} initial={loadPicks(month, "sr")} />
  );
}
