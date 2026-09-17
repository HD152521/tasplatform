/**
 * SR 보고서를 여러 번에 나눠 만든다.
 *
 * 왜 나누는가 — 사내 LLM 엔드포인트의 출력 상한이 512 토큰이다. 양식대로 쓴 보고서는
 * 한국어 1,800~2,500자(1,200~1,800 토큰)라 한 번에 나올 수가 없다. 실제로 저장된
 * 생성물은 입력 크기가 10배 차이 나는데도 전부 474~608자에 몰려 있었다 — 내용이 정한
 * 길이가 아니라 상한이 정한 길이다. 프롬프트를 고쳐도 이 벽은 넘지 못한다.
 *
 * 그래서 이렇게 한다.
 *   1단계 사실 추출 — 스레드를 몇 개씩 묶어 병렬로 부르고, 작은 JSON 만 받는다.
 *   2단계 병합      — 코드가 한다. 모델을 부르지 않는다.
 *   3단계 섹션 생성 — 절마다 따로 부른다. 각 호출의 출력이 상한 안에 들어간다.
 *                     원문 대신 2단계 JSON 만 보므로 입력도 작고 없는 말이 덜 섞인다.
 *   4단계 조립      — 코드가 한다. 그래서 양식이 깨질 수 없다. 지금까지는 모델이
 *                     내용과 양식을 동시에 맞춰야 했고 어긋나면 슬라이드 칸이 비었다.
 *
 * chat 을 인자로 받는다. server-only 를 붙이지 않으려는 것이고(수집기·테스트에서
 * 부른다), 모델 없이 순수 함수만 시험할 수 있게 하려는 것이다.
 */
import { condenseBody } from "./srSource.ts";

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export type ChatFn = (system: string, user: string, options?: ChatOptions) => Promise<string>;

/** 한 번에 넘길 스레드 수. 4개면 추출 JSON 이 상한의 절반쯤에서 끝난다. */
export const BATCH_SIZE = 4;
/** 호출당 출력 상한. 엔드포인트 상한(512)보다 낮게 잡아 잘림을 만들지 않는다. */
export const CALL_MAX_TOKENS = 480;
/** 호출 하나가 오래 붙잡지 않도록. 단계가 많아 전체 예산을 나눠 쓴다. */
export const CALL_TIMEOUT_MS = 60_000;

export interface SourceThread {
  isOurs: boolean;
  at: string;
  /** epoch ms. 중복 판정의 시간창에 쓴다. 없으면 판정을 걸지 않는다. */
  atMs?: number;
  body: string;
}

export interface Fact {
  /** 누가 한 말인가. 이 구분이 없으면 TAC 권고와 고객 조치가 섞인다. */
  actor: "TAC" | "CUSTOMER";
  /** 언제. 시간순 정렬에 쓴다. 모르면 빈 문자열. */
  at: string;
  /** 무슨 내용인가. 한 문장. */
  text: string;
  /** 수치·버전·설정값. 보고서에서 제일 잘 빠지는 것들이라 따로 받는다. */
  metrics: string;
}

export interface RuledOut {
  /** 검토했다가 아닌 것으로 밝혀진 가설. */
  hypothesis: string;
  /** 왜 아닌가. */
  why: string;
}

export interface Extraction {
  facts: Fact[];
  /** 대상 환경·버전·설정값. */
  environment: string[];
  /** 배제된 가설. 이 칸이 없어서 "참고로 안내한 알려진 이슈"가 원인으로 격상됐다. */
  ruledOut: RuledOut[];
}

export const EMPTY_EXTRACTION: Extraction = { facts: [], environment: [], ruledOut: [] };

/* ------------------------------------------------------------------ *
 * 순수 함수 — 모델 없이 시험한다.
 * ------------------------------------------------------------------ */

/** 스레드를 size 개씩 묶는다. */
export function batchThreads<T>(threads: readonly T[], size: number = BATCH_SIZE): T[][] {
  if (size < 1) throw new Error("묶음 크기는 1 이상이어야 합니다.");
  const batches: T[][] = [];
  for (let i = 0; i < threads.length; i += size) batches.push(threads.slice(i, i + size));
  return batches;
}

/** 한 묶음을 모델에 넘길 텍스트로. 서명은 걷어낸다. */
export function renderBatch(threads: readonly SourceThread[]): string {
  return threads
    .map((t) => `--- ${t.isOurs ? "고객사" : "Broadcom TAC"} (${t.at}) ---\n${condenseBody(t.body)}`)
    .join("\n\n");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter((v) => v !== "") : [];
}

/**
 * 모델이 준 JSON 을 읽는다.
 *
 * 코드펜스를 붙이거나 앞뒤에 인사말을 다는 일이 있어 중괄호 범위만 떼어 낸다.
 * 해석에 실패하면 빈 결과를 돌려준다 — 한 묶음이 깨졌다고 나머지를 버리지 않는다.
 */
export function parseFactJson(raw: string): Extraction {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return EMPTY_EXTRACTION;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return EMPTY_EXTRACTION;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY_EXTRACTION;

  const root = parsed as Record<string, unknown>;
  const rawFacts = Array.isArray(root.facts) ? root.facts : [];
  const facts: Fact[] = [];
  for (const item of rawFacts) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    const text = asString(f.text);
    if (text === "") continue;
    // 프롬프트는 영문 라벨을 시키지만 지시가 한국어라 "고객사" 로 쓰는 일이 있다. 둘 다 받는다.
    // 알 수 없는 값은 TAC 으로 둔다 — 스레드 대다수가 TAC 이고, 머리글을 그대로 따르라고
    // 지시해 두었다. 다만 이 기본값이 고객 조치를 TAC 권고로 둔갑시킬 수 있는 자리다.
    const actorRaw = asString(f.actor).toUpperCase();
    const isCustomer = actorRaw === "CUSTOMER" || actorRaw.includes("고객");
    facts.push({
      actor: isCustomer ? "CUSTOMER" : "TAC",
      at: asString(f.at),
      text,
      metrics: asString(f.metrics),
    });
  }

  const rawRuled = Array.isArray(root.ruled_out) ? root.ruled_out : [];
  const ruledOut: RuledOut[] = [];
  for (const item of rawRuled) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const hypothesis = asString(r.hypothesis);
    if (hypothesis === "") continue;
    ruledOut.push({ hypothesis, why: asString(r.why) });
  }

  return { facts, environment: asStringList(root.environment), ruledOut };
}

/** 같은 내용이 여러 묶음에서 나올 수 있어 합치면서 중복을 건다. */
export function mergeExtractions(list: readonly Extraction[]): Extraction {
  const facts: Fact[] = [];
  const seenFact = new Set<string>();
  const environment: string[] = [];
  const seenEnv = new Set<string>();
  const ruledOut: RuledOut[] = [];
  const seenRuled = new Set<string>();

  for (const part of list) {
    for (const fact of part.facts) {
      const key = `${fact.actor}|${fact.text.replace(/\s+/g, "")}`;
      if (seenFact.has(key)) continue;
      seenFact.add(key);
      facts.push(fact);
    }
    for (const item of part.environment) {
      const key = item.replace(/\s+/g, "");
      if (seenEnv.has(key)) continue;
      seenEnv.add(key);
      environment.push(item);
    }
    for (const item of part.ruledOut) {
      const key = item.hypothesis.replace(/\s+/g, "");
      if (seenRuled.has(key)) continue;
      seenRuled.add(key);
      ruledOut.push(item);
    }
  }
  return { facts, environment, ruledOut };
}

/** 추출 결과를 섹션 생성용 텍스트로. 모델이 원문 대신 이것만 본다. */
export function renderFacts(extraction: Extraction): string {
  const parts: string[] = [];
  if (extraction.environment.length > 0) {
    parts.push("[대상 환경·버전·설정값]", ...extraction.environment.map((e) => `- ${e}`), "");
  }
  parts.push("[경과 사실]");
  for (const fact of extraction.facts) {
    const who = fact.actor === "CUSTOMER" ? "고객사" : "TAC";
    const when = fact.at === "" ? "" : ` ${fact.at}`;
    const metrics = fact.metrics === "" ? "" : ` (수치: ${fact.metrics})`;
    parts.push(`- [${who}${when}] ${fact.text}${metrics}`);
  }
  if (extraction.ruledOut.length > 0) {
    parts.push("", "[검토했으나 원인이 아닌 것으로 밝혀진 가설 — 원인으로 쓰지 말 것]");
    for (const item of extraction.ruledOut) {
      parts.push(`- ${item.hypothesis}${item.why === "" ? "" : ` → ${item.why}`}`);
    }
  }
  return parts.join("\n");
}

/** 절을 기존 양식으로 붙인다. 조립을 코드가 하므로 양식은 깨질 수 없다. */
export function assembleReport(sections: {
  title: string;
  inquiry: string;
  progress: string;
  result: string;
}): string {
  return [
    "SR 제목",
    `- • ${sections.title.trim()}`,
    "",
    "분석 및 진행상황",
    "",
    "- 질의 내용",
    sections.inquiry.trim(),
    "",
    "- 진행 상황",
    sections.progress.trim(),
    "",
    "최종 결과",
    `- • ${sections.result.trim()}`,
  ].join("\n");
}

/** 모델이 군더더기를 붙였을 때 첫 줄만 쓰는 절(제목·최종 결과)용 정리. */
export function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^\s*[-•*]\s*/, "").replace(/^\s*[-•*]\s*/, "").trim())
    .find((l) => l !== "");
  return (line ?? "").replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
}

/** 절 본문에서 코드펜스와 절 제목 반복을 걷어낸다. */
export function cleanSection(text: string): string {
  return text
    .replace(/^```[\w]*\s*$/gm, "")
    .split("\n")
    .filter((line) => !/^\s*[-•]?\s*(질의 내용|진행 상황|분석 및 진행상황|SR 제목|최종 결과)\s*$/.test(line))
    .join("\n")
    .trim();
}
