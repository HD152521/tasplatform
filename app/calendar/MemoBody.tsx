"use client";

import { memoBlocks } from "../../lib/memoBlocks.ts";
import type { MentionSpan } from "../../lib/mentionSpans.ts";
import { COLOR, RADIUS } from "../ui.tsx";
import type { MemberChip } from "./CalendarBoard.tsx";

/**
 * 일정 본문을 **읽을 수 있게** 그린다.
 *
 * Jira 에 올리지 않는 일정(메모지)은 이 화면이 그 글을 보여 주는 **유일한 자리**다.
 * 전에는 `white-space: pre-wrap` 한 덩어리였다 — 글머리 기호를 적어도 들여쓰기가 없고,
 * 문단도 구분되지 않고, `@이름` 도 그냥 글자였다. Jira 로 가던 일정은 Jira 가 정리해
 * 주었는데 메모는 아무도 정리해 주지 않았다.
 *
 * 가르는 규칙은 lib/memoBlocks.ts 에 있고, 그 안의 `@이름` 판정은 Jira 본문과 **같은
 * 모듈**을 쓴다(lib/mentionSpans.ts). 여기서 강조된 이름은 Jira 에서도 멘션이 된다.
 */
export function MemoBody({
  text,
  members = [],
}: {
  text: string;
  members?: readonly MemberChip[];
}) {
  const layout = memoBlocks(
    text,
    members.map((m) => ({
      displayName: m.displayName,
      loginId: m.loginId,
      // 화면에서는 "Jira 계정이 있는가" 만 알면 된다 — 실제 accountId 는 서버가 쓴다.
      jiraAccountId: m.hasJira ? "linked" : "",
    })),
  );
  if (layout.blocks.length === 0) return null;

  return (
    <div style={{ fontSize: 13, color: COLOR.body, lineHeight: 1.75 }}>
      {layout.blocks.map((block, i) => {
        if (block.kind === "para") {
          return (
            <p key={i} style={{ margin: i === 0 ? "0" : "10px 0 0" }}>
              {block.lines.map((spans, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  <Spans spans={spans} />
                </span>
              ))}
            </p>
          );
        }
        return (
          <ul
            key={i}
            style={{
              margin: i === 0 ? "0" : "10px 0 0",
              padding: 0,
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            {block.items.map((item, j) => (
              <li key={j} style={{ display: "flex", gap: 7 }}>
                {/*
                  기호 칸을 고정 폭으로 둔다. 글이 두 줄로 넘어가도 둘째 줄이 기호 아래로
                  파고들지 않는다 — 그게 목록으로 안 보이게 만드는 가장 흔한 이유다.
                */}
                <span
                  style={{
                    flex: "0 0 auto",
                    minWidth: block.kind === "number" ? 18 : 8,
                    color: COLOR.faint,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {item.marker === "" ? "·" : item.marker}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <Spans spans={item.spans} />
                </span>
              </li>
            ))}
          </ul>
        );
      })}

      {/* 이름은 맞췄는데 Jira 계정이 없는 사람. 올릴 때 멘션이 안 되는 것을 미리 말해 준다. */}
      {layout.unlinked.length > 0 && (
        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: COLOR.faint, lineHeight: 1.7 }}>
          {layout.unlinked.join(" · ")} 은 Jira 계정이 연결되지 않아 올릴 때 글자로만 남습니다.
        </p>
      )}
    </div>
  );
}

/** 글 조각. 멘션만 눈에 띄게 둔다 — 그 이름이 실제로 알림을 받는 이름이다. */
function Spans({ spans }: { spans: readonly MentionSpan[] }) {
  return (
    <>
      {spans.map((span, i) =>
        span.kind === "text" ? (
          <span key={i}>{span.text}</span>
        ) : (
          <span
            key={i}
            style={{
              color: COLOR.accent,
              background: COLOR.waitThemBg,
              borderRadius: RADIUS.badge,
              padding: "1px 5px",
              fontWeight: 600,
              fontSize: 12.5,
            }}
          >
            @{span.label}
          </span>
        ),
      )}
    </>
  );
}
