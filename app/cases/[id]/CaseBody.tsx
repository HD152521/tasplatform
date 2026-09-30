"use client";

/**
 * 글 한 건의 본문과 그 글만의 번역 버튼.
 *
 * 위쪽 "전체 번역" 만 있던 때는 몇 개만 보고 싶어도 전부 기다려야 했다. 글마다 버튼을
 * 두어 **원하는 것만** 부른다. 버튼은 보안 공지·기술 문서에서 쓰는 것을 그대로 쓴다
 * (app/TranslateButton.tsx) — 같은 일을 하는 자리라 모양이 달라야 할 이유가 없다.
 *
 * 무엇을 보일지는 lib/caseTranslate.ts 의 translateControl 이 정한다. 위쪽 전체 번역과
 * 이 버튼이 같은 사실(저장된 번역이 있는지)을 보게 하려고 판정을 한 곳에 모았다.
 */
import { useState } from "react";
import {
  type TranslateScope,
  translateControl,
} from "../../../lib/caseTranslate.ts";
import { TranslateButton, translateButtonStyle } from "../../TranslateButton.tsx";
import { COLOR } from "../../ui.tsx";

export function CaseBody({
  requestId, scope, refId, text, translation, translatable, defaultKorean,
}: {
  requestId: number;
  scope: TranslateScope;
  /** case_desc 는 케이스 번호, thread 는 대화 번호. text_translations 의 ref_id 다. */
  refId: number;
  /** 원문. 정본이라 언제나 이것으로 돌아올 수 있다. */
  text: string;
  /** 저장된 번역. 없으면 null. */
  translation: string | null;
  /** 원문이 영문이라 번역할 수 있는가. */
  translatable: boolean;
  /** 화면 전체가 한국어 보기인가(?lang=ko). 이 글의 기본값이 된다. */
  defaultKorean: boolean;
}) {
  /**
   * 이 글만의 선택. null 이면 화면 전체의 선택(defaultKorean)을 따른다.
   *
   * 고정된 boolean 대신 3값으로 두는 이유: 위쪽 전체 번역이 끝나고 화면을 다시 그리면
   * 번역이 새로 실려 오는데, boolean 초기값은 처음 렌더의 값에 묶여 그때 원문에 머문다.
   */
  const [choice, setChoice] = useState<"ko" | "en" | null>(null);
  const hasTranslation = translation !== null && translation !== "";
  const wantKorean = choice === null ? defaultKorean : choice === "ko";
  const showingKorean = wantKorean && hasTranslation;
  const control = translateControl({ translatable, hasTranslation, showingKorean });

  return (
    <>
      <p style={{
        margin: 0, fontSize: 14, lineHeight: 1.75, color: COLOR.body,
        whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}>
        {showingKorean ? translation : (text === "" ? "(본문 없음)" : text)}
      </p>

      {/*
        버튼은 본문 아래 오른쪽에 둔다. 말풍선 사이(카드 경계)에 걸치면 겹쳐 보이고,
        머리줄에 넣으면 좁은 화면에서 작성자 이름과 시각을 밀어낸다.
      */}
      {text !== "" && (
        <div style={{
          marginTop: 10, display: "flex", justifyContent: "flex-end",
          alignItems: "center", gap: 8, flexWrap: "wrap",
        }}>
          {control.kind === "korean" && (
            <span style={{ fontSize: 11, color: COLOR.faint }}>{control.label}</span>
          )}
          {control.kind === "translate" && (
            <TranslateButton
              url={`/api/cases/${requestId}/translate?scope=${scope}&ref=${refId}`}
              compact
              // 방금 누른 글은 번역을 보여 준다. 원문 보기 화면에서 눌렀을 때도 마찬가지다.
              onDone={() => setChoice("ko")}
            />
          )}
          {control.kind === "toggle" && (
            <button
              type="button"
              onClick={() => setChoice(showingKorean ? "en" : "ko")}
              style={translateButtonStyle(true)}
            >
              {control.label}
            </button>
          )}
        </div>
      )}
    </>
  );
}
