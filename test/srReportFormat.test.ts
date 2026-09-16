import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSourceText, isComplete, parseSrReport, severityDigit, statusLabel,
} from "../lib/srReportFormat.ts";

const SAMPLE = `SR 제목
- • Ops Manager 인증서 만료 경고 발생 원인 확인

분석 및 진행상황

- 질의 내용
Ops Manager UI 로그인 시 75일 이내 만료 경고 발생. Certificates 메뉴에서는 해당 인증서 미확인

경고 발생 원인 및 정상 동작 여부 확인

- 진행 상황
현상 파악: Certificates 화면과 실제 배포 인증서 목록의 불일치 확인

근본 원인 규명: 비활성 상태의 구 Root CA 및 NATS CA 잔존 확인

TAC 권고사항: 기존 CA 삭제 절차 실행 안내받음

후속 조치 방향: 삭제 절차 적용 후 경고 해제 여부 재확인 필요

최종 결과
- • 미삭제 CA 가 원인임을 확인하여 고객사에 전달 완료`;

test("세 절을 각각 잘라낸다", () => {
  const r = parseSrReport(SAMPLE);
  assert.equal(r.title, "Ops Manager 인증서 만료 경고 발생 원인 확인");
  assert.match(r.analysis, /질의 내용/);
  assert.match(r.analysis, /진행 상황/);
  assert.equal(r.result, "미삭제 CA 가 원인임을 확인하여 고객사에 전달 완료");
});

test("제목과 결과의 글머리 기호를 걷어낸다", () => {
  const r = parseSrReport(SAMPLE);
  assert.ok(!r.title.startsWith("-"), r.title);
  assert.ok(!r.title.startsWith("•"), r.title);
  assert.ok(!r.result.startsWith("-"), r.result);
});

test("분석 절에 질의 내용과 진행 상황이 모두 들어간다", () => {
  const r = parseSrReport(SAMPLE);
  assert.match(r.analysis, /근본 원인 규명/);
  assert.match(r.analysis, /후속 조치 방향/);
  assert.ok(!r.analysis.includes("최종 결과"), "다음 절이 섞이면 안 된다");
});

// 형식이 어긋났다고 억지로 짜맞추면 엉뚱한 내용이 슬라이드에 들어간다.
test("형식이 어긋나면 비워 두고 원문을 남긴다", () => {
  const r = parseSrReport("그냥 줄글로 쓴 요약입니다.");
  assert.equal(r.title, "");
  assert.equal(r.analysis, "");
  assert.equal(r.result, "");
  assert.equal(r.raw, "그냥 줄글로 쓴 요약입니다.");
  assert.equal(isComplete(r), false);
});

test("세 절이 다 차면 완성으로 본다", () => {
  assert.equal(isComplete(parseSrReport(SAMPLE)), true);
});

test("빈 입력도 예외 없이 처리한다", () => {
  const r = parseSrReport("");
  assert.equal(isComplete(r), false);
  assert.equal(r.raw, "");
});

test("케이스 본문과 답변을 한 덩어리로 만든다", () => {
  const text = buildSourceText({
    requestId: "37040435", subject: "Certificate expiry", status: "Closed",
    priority: "3", product: "TAS", createdOn: "10-August-2026", closedOn: "11-August-2026",
    description: "Ops Manager warning",
    threads: [
      { isOurs: true, at: "10-August-2026", body: "문의드립니다" },
      { isOurs: false, at: "11-August-2026", body: "Please delete old CAs" },
    ],
  });
  assert.match(text, /SR No\.: 37040435/);
  assert.match(text, /최초 문의 내용/);
  assert.match(text, /고객사\/당사/);
  assert.match(text, /Broadcom TAC/);
  assert.match(text, /Please delete old CAs/);
});

test("본문이 없어도 표기를 남긴다", () => {
  const text = buildSourceText({
    requestId: "1", subject: "s", status: "Open", priority: "3", product: "TAS",
    createdOn: "", closedOn: "", description: "   ", threads: [],
  });
  assert.match(text, /\(없음\)/);
});

// 양식은 심각도를 숫자로, 상태를 한국어로 쓴다.
test("심각도에서 숫자만 뽑는다", () => {
  assert.equal(severityDigit("High - P2"), "2");
  assert.equal(severityDigit("Critical - P1"), "1");
  assert.equal(severityDigit("Low - P4"), "4");
  assert.equal(severityDigit("3"), "3");
});

test("숫자가 없으면 원문을 그대로 둔다", () => {
  assert.equal(severityDigit("Medium"), "Medium");
  assert.equal(severityDigit(""), "");
});

test("포털 상태를 보고서 표기로 바꾼다", () => {
  assert.equal(statusLabel("Closed"), "종료");
  assert.equal(statusLabel("Resolved"), "종료");
  assert.equal(statusLabel("Pending Customer"), "고객 확인");
  assert.equal(statusLabel("Open"), "진행중");
});

// 모르는 상태를 임의로 바꾸면 사실이 왜곡된다.
test("모르는 상태는 그대로 둔다", () => {
  assert.equal(statusLabel("Awaiting Vendor"), "Awaiting Vendor");
});
