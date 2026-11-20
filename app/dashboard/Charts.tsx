/**
 * 대시보드용 그림 조각 — **의존성 0.**
 *
 * 차트 라이브러리를 쓰지 않는다. 이 레포는 `node_modules` 를 통째로 드롭릿에 올리고
 * 사내망에서 npm 레지스트리에 닿는지가 불확실하다(.cfignore 머리말). 그래서 막대는
 * div 로, 도넛은 인라인 SVG 로 그린다 — 둘 다 서버에서 그려지고 스크립트가 없다.
 *
 * 숫자를 글자로만 두지 않는 이유: "완료 4 · 진행 2 · 예정 7" 은 읽어서 비교해야 하고,
 * 같은 것을 길이로 보여 주면 **보는 순간** 비율이 들어온다. 다만 **숫자를 지우지는
 * 않는다** — 그림만 있으면 정확한 값을 알 수 없다.
 */
import { COLOR, MONO_STACK } from "../ui.tsx";

export interface Slice {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

/**
 * 한 줄 누적 막대. 비율을 한눈에 보여 준다.
 *
 * 값이 0 인 조각은 그리지 않는다 — 폭 0 의 조각이 테두리만 남아 줄을 더럽힌다.
 * 전부 0 이면 빈 띠를 그리고 "없음" 을 말한다(아무것도 안 그리면 고장처럼 보인다).
 */
export function StackBar({ slices, height = 10 }: { slices: readonly Slice[]; height?: number }) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  return (
    <div>
      <div style={{
        display: "flex", height, borderRadius: height / 2, overflow: "hidden",
        background: COLOR.ground,
      }}>
        {total > 0 &&
          slices
            .filter((s) => s.value > 0)
            .map((s) => (
              <div
                key={s.label}
                title={`${s.label} ${s.value}건`}
                style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
              />
            ))}
      </div>

      <div style={{
        display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8,
        fontSize: 12, color: COLOR.body,
      }}>
        {total === 0 ? (
          <span style={{ color: COLOR.faint }}>없음</span>
        ) : (
          slices
            .filter((s) => s.value > 0)
            .map((s) => (
              <span key={s.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
                {s.label}
                <strong style={{ fontFamily: MONO_STACK }}>{s.value}</strong>
              </span>
            ))
        )}
      </div>
    </div>
  );
}

export interface BarRow {
  readonly label: string;
  readonly value: number;
  /** 강조할 줄(예: 나). */
  readonly highlight?: boolean;
}

/**
 * 가로 막대 목록. 사람별·망별 건수처럼 **서로 비교하는** 값에 쓴다.
 *
 * 가장 큰 값을 100% 로 잡는다(전체 합이 아니라). 비교 대상이 서로이기 때문이다 —
 * 합을 기준으로 하면 항목이 많을 때 모든 막대가 짧아져 차이가 안 보인다.
 */
export function BarList({ rows, max = 6 }: { rows: readonly BarRow[]; max?: number }) {
  if (rows.length === 0) {
    return <p style={{ margin: 0, fontSize: 12.5, color: COLOR.faint }}>없음</p>;
  }
  const top = rows.slice(0, max);
  const peak = Math.max(...top.map((r) => r.value), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {top.map((row) => (
        <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5 }}>
          <span style={{
            width: 88, flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden",
            textOverflow: "ellipsis",
            fontWeight: row.highlight === true ? 700 : 400,
            color: row.highlight === true ? COLOR.accent : COLOR.body,
          }}>
            {row.label}
          </span>
          <span style={{ flex: 1, minWidth: 0, background: COLOR.ground, borderRadius: 3, height: 8 }}>
            <span style={{
              display: "block", height: 8, borderRadius: 3,
              width: `${Math.max((row.value / peak) * 100, 4)}%`,
              background: row.highlight === true ? COLOR.accent : COLOR.waitThem,
            }} />
          </span>
          <span style={{
            fontFamily: MONO_STACK, fontSize: 12, color: COLOR.muted,
            width: 26, textAlign: "right", flexShrink: 0,
          }}>
            {row.value}
          </span>
        </div>
      ))}
      {rows.length > max && (
        <div style={{ fontSize: 11.5, color: COLOR.faint }}>그 외 {rows.length - max}명</div>
      )}
    </div>
  );
}

/**
 * 도넛 하나. "전체 중 얼마" 를 한 눈에.
 *
 * SVG 원 하나에 `stroke-dasharray` 로 채운 만큼만 그린다 — 조각을 여러 개 그리지
 * 않으므로 경로 계산이 필요 없고, 서버에서 그대로 문자열로 나간다.
 */
export function Donut({
  done, total, label, color = COLOR.ok, size = 92,
}: {
  done: number;
  total: number;
  label: string;
  color?: string;
  size?: number;
}) {
  const radius = (size - 12) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = total === 0 ? 0 : done / total;
  const percent = Math.round(ratio * 100);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={COLOR.ground} strokeWidth={10}
        />
        {/* 12시에서 시작해 시계 방향으로 차게 돌려 둔다 — 사람이 기대하는 방향이다. */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={color} strokeWidth={10} strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
          fontSize={size / 4.2} fontWeight={700} fill={COLOR.ink}
          fontFamily={MONO_STACK}
        >
          {total === 0 ? "-" : `${percent}%`}
        </text>
      </svg>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: COLOR.body }}>{label}</div>
        <div style={{ fontSize: 12, color: COLOR.muted, marginTop: 3, fontFamily: MONO_STACK }}>
          {done} / {total}
        </div>
      </div>
    </div>
  );
}
