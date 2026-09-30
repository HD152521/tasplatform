import Link from "next/link";
import { AttachmentLink } from "./AttachmentLink.tsx";
import { InlineImages } from "./InlineImages.tsx";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  caseTranslateTargets, translationKey, untranslated,
} from "../../../lib/caseTranslate.ts";
import { CaseBody } from "./CaseBody.tsx";
import {
  getCase, isClosedStatus, listAttachments, listThreadInlineImages, listThreads,
  loadCaseTranslations, markCaseRead,
  type AttachmentViewRow,
} from "../../../lib/queries.ts";
import { Badge, COLOR, Card, MONO_STACK, RADIUS, formatStamp, statusColors } from "../../ui.tsx";
import { ReplyBox } from "./ReplyBox.tsx";
import { LangToggle } from "./LangToggle.tsx";
import { SummaryPanel } from "./SummaryPanel.tsx";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { id } = await params;
  // 기본은 원문이다. 원문이 정본이고 번역은 읽기를 돕는 보조다.
  const lang = (await searchParams).lang === "ko" ? "ko" : "en";
  const requestId = Number(id);
  if (!Number.isFinite(requestId)) notFound();

  const detail = await getCase(requestId);
  if (detail === null) notFound();

  const inlineImages = await listThreadInlineImages(requestId);
  const threads = await listThreads(requestId);
  const attachments = await listAttachments(requestId);
  await markCaseRead(requestId);

  const closed = isClosedStatus(detail.status);
  const tone = statusColors(detail.status);

  const byThread = new Map<number, AttachmentViewRow[]>();
  for (const doc of attachments) {
    const key = doc.thread_id ?? 0;
    byThread.set(key, [...(byThread.get(key) ?? []), doc]);
  }

  // 저장된 번역은 **원문 보기에서도** 싣는다. 글마다의 번역 버튼이 "이 글에 번역이
  // 있는지" 를 알아야 "번역" 과 "한국어 보기" 를 가려 낼 수 있다.
  const refs = [
    { scope: "case_desc", refId: requestId },
    ...threads.map((t) => ({ scope: "thread", refId: t.thread_id })),
  ];
  const translated = await loadCaseTranslations(refs);
  /** 번역할 수 있는 글(영문). 한국어 원문과 빈 글은 빠져 있다. */
  const targets = caseTranslateTargets({
    requestId,
    descriptionText: detail.description_text,
    threads: threads.map((t) => ({ threadId: t.thread_id, bodyText: t.body_text })),
  });
  /** 아직 번역이 없어 원문으로 보이는 건수. 위쪽 "전체 번역" 이 이 수만큼 부른다. */
  const pending = untranslated(targets, translated).length;
  /**
   * 이 글에 번역 버튼을 낼지. 판정을 다시 하지 않고 targets 에서 되읽는다 —
   * 라우트가 번역할 목록과 화면이 버튼을 내는 목록이 한 글자도 어긋나지 않게 한다.
   */
  const translatableKeys = new Set(targets.map((t) => translationKey(t.scope, t.refId)));
  /** 저장된 번역. 없으면 null — 화면은 원문을 쓴다. */
  const translationOf = (scope: string, refId: number): string | null =>
    translated.get(translationKey(scope, refId)) ?? null;

  const lastThread = threads[threads.length - 1];
  const waitingOnUs = lastThread !== undefined && lastThread.is_ours === 0;

  return (
    <>
      <Link href={closed ? "/closed" : "/"} style={{ fontSize: 13, color: COLOR.accent, textDecoration: "none" }}>
        ← {closed ? "종료 케이스" : "진행중 케이스"}
      </Link>

      <header style={{ margin: "14px 0 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: MONO_STACK, fontSize: 12, color: COLOR.faint }}>
            {detail.request_id_formatted}
          </span>
          <Badge fg={tone.fg} bg={tone.bg}>{detail.status}</Badge>
          {detail.unread_replies > 0 && (
            <Badge fg={COLOR.waitUs} bg={COLOR.waitUsBg} strong>새 답변 {detail.unread_replies}</Badge>
          )}
          <span style={{ fontSize: 11, color: COLOR.muted }}>{detail.priority}</span>
        </div>

        <h1 style={{
          fontSize: 21, fontWeight: 600, margin: 0, lineHeight: 1.35,
          letterSpacing: "-0.015em", textWrap: "pretty",
        }}>
          {detail.subject}
        </h1>

        <div style={{ display: "flex", gap: 14, marginTop: 9, fontSize: 12, color: COLOR.muted, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 500, color: "#4b5563" }}>{detail.party_name}</span>
          <span style={{ color: "#d6dae0" }}>·</span>
          <span>{detail.category}</span>
          {detail.case_version !== null && (
            <>
              <span style={{ color: "#d6dae0" }}>·</span>
              <span style={{ fontFamily: MONO_STACK }}>{`v${detail.case_version}`}</span>
            </>
          )}
          <span style={{ marginLeft: "auto" }}>
            <LangToggle requestId={detail.request_id} lang={lang} pending={pending} />
          </span>
        </div>
      </header>

      {closed && <SummaryPanel requestId={detail.request_id} />}

      <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
        <section style={{ flex: 1, minWidth: 0 }}>
          {detail.description_text !== "" && (
            <Card style={{ padding: "18px 20px", marginBottom: 14 }}>
              <SpeakerRow ours label="최초 등록 내용" at={formatStamp(detail.created_on_ms)} />
              {/* 최초 등록 글도 같은 저장소(scope=case_desc)를 쓰므로 버튼을 함께 붙인다. */}
              <CaseBody
                requestId={requestId}
                scope="case_desc"
                refId={requestId}
                text={detail.description_text}
                translation={translationOf("case_desc", requestId)}
                translatable={translatableKeys.has(translationKey("case_desc", requestId))}
                defaultKorean={lang === "ko"}
              />
            </Card>
          )}

          {threads.length === 0 && detail.description_text === "" && (
            <Card style={{ padding: 40, textAlign: "center", color: COLOR.faint, fontSize: 13 }}>
              수집된 대화가 없습니다.
            </Card>
          )}

          {threads.map((thread, i) => {
            const ours = thread.is_ours === 1;
            const latest = i === threads.length - 1 && !ours;
            const docs = byThread.get(thread.thread_id) ?? [];
            return (
              <Card key={thread.thread_id} style={{
                padding: "18px 20px", marginBottom: 14,
                background: ours ? "#fafbfc" : COLOR.surface,
                borderColor: latest ? "#f3c7c2" : COLOR.line,
                boxShadow: latest ? `0 0 0 3px ${COLOR.waitUsBg}` : undefined,
              }}>
                <SpeakerRow
                  ours={ours}
                  label={ours ? "우리" : (thread.author_unit === "" ? "Broadcom" : thread.author_unit)}
                  at={formatStamp(thread.res_date_ms)}
                  latest={latest}
                />
                <CaseBody
                  requestId={requestId}
                  scope="thread"
                  refId={thread.thread_id}
                  text={thread.body_text}
                  translation={translationOf("thread", thread.thread_id)}
                  translatable={translatableKeys.has(translationKey("thread", thread.thread_id))}
                  defaultKorean={lang === "ko"}
                />
                {/* Broadcom 이 본문에 박아 보낸 화면 캡처. 첨부와 달리 글 안에 있다. */}
                <InlineImages ids={inlineImages.get(thread.thread_id) ?? []} />
                {docs.length > 0 && <Files docs={docs} />}
              </Card>
            );
          })}

          {/* 진행중 케이스에만. 종료된 건에는 답변할 수 없다. */}
          {!closed && (
            <ReplyBox requestId={detail.request_id} caseLabel={detail.request_id_formatted} />
          )}
        </section>

        <aside style={{ width: 286, flexShrink: 0 }}>
          <Card style={{ padding: "18px 18px 10px", marginBottom: 14 }}>
            <RailTitle>진행 상황</RailTitle>
            <Fact label="상태" value={detail.status} color={tone.fg} />
            <Fact
              label="우리 차례"
              value={waitingOnUs ? "예 — 답변 대기중" : "아니오"}
              color={waitingOnUs ? COLOR.waitUs : undefined}
            />
            <Fact label="등록" value={formatStamp(detail.created_on_ms)} />
            <Fact label={closed ? "종료" : "최종 갱신"} value={formatStamp(detail.last_updated_ms)} />
            <Fact label="대화" value={`${detail.thread_count}건`} />
            <Fact label="답변" value={`${detail.reply_count}건`} />
          </Card>

          {attachments.length > 0 && (
            <Card style={{ padding: "18px 18px 20px" }}>
              <RailTitle>
                {"첨부파일 "}
                <span style={{ fontFamily: MONO_STACK, color: COLOR.muted }}>{attachments.length}</span>
              </RailTitle>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {attachments.map((doc) => (
                  <FileRow key={doc.document_id} doc={doc} compact />
                ))}
              </div>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}

function SpeakerRow({
  ours, label, at, latest,
}: { ours: boolean; label: string; at: string; latest?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11 }}>
      <span style={{
        width: 26, height: 26, borderRadius: 7, fontSize: 10, fontWeight: 600,
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        color: ours ? "#4b5563" : COLOR.waitThem,
        background: ours ? "#eef1f6" : COLOR.waitThemBg,
      }}>
        {ours ? "우리" : "BC"}
      </span>
      <span style={{
        fontSize: 13, fontWeight: 600, minWidth: 0,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {label}
      </span>
      {latest === true && <Badge fg={COLOR.waitUs} bg={COLOR.waitUsBg} strong>최신</Badge>}
      <span style={{ marginLeft: "auto", fontSize: 12, color: COLOR.faint, flexShrink: 0 }}>{at}</span>
    </div>
  );
}

function RailTitle({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: COLOR.faint,
      letterSpacing: "0.04em", marginBottom: 12,
    }}>
      {children}
    </div>
  );
}

function Fact({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
      <span style={{ width: 68, flexShrink: 0, color: COLOR.faint, fontSize: 12 }}>{label}</span>
      <span style={{
        fontSize: 13, minWidth: 0,
        color: color === undefined ? COLOR.ink : color,
        fontWeight: color === undefined ? 400 : 500,
      }}>
        {value}
      </span>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function extOf(name: string): string {
  const match = /[.]([a-z0-9]{1,5})$/i.exec(name);
  const ext = match === null ? undefined : match[1];
  return ext === undefined || ext === "" ? "FILE" : ext.toUpperCase().slice(0, 4);
}

/**
 * 첨부 목록.
 * 파일 실체는 Broadcom(supportftp)에 있어 링크만 건다 — 204MB, 630MB 짜리도 있다.
 */
function Files({ docs }: { docs: AttachmentViewRow[] }) {
  return (
    <div style={{
      marginTop: 13, paddingTop: 12, borderTop: `1px dashed ${COLOR.line}`,
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      {docs.map((doc) => <FileRow key={doc.document_id} doc={doc} />)}
    </div>
  );
}

function FileRow({ doc, compact = false }: { doc: AttachmentViewRow; compact?: boolean }) {
  const style = {
    display: "flex", alignItems: "center", gap: 10, padding: "9px 10px",
    border: `1px solid ${COLOR.divider}`, borderRadius: RADIUS.control,
    textDecoration: "none", background: COLOR.surface,
  } as const;

  const inner = (
    <>
      <span style={{
        width: 30, height: 30, flexShrink: 0, borderRadius: 6,
        fontSize: 9, fontWeight: 600,
        display: "flex", alignItems: "center", justifyContent: "center",
        color: COLOR.muted, background: "#f0f2f5",
      }}>
        {extOf(doc.doc_name)}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{
          display: "block", fontSize: compact ? 12 : 13, color: COLOR.accent,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {doc.doc_name === "" ? "(이름 없음)" : doc.doc_name}
        </span>
        <span style={{
          display: "block", fontFamily: MONO_STACK, fontSize: 11,
          color: COLOR.faint, marginTop: 2,
        }}>
          {formatSize(doc.file_size)}
          {doc.uploaded_ms === null ? "" : ` · ${formatStamp(doc.uploaded_ms)}`}
        </span>
      </span>
    </>
  );

  // 첨부는 수집기(브라우저가 있는 기계)가 받아 온다. 여기서는 그 결과를 받아 저장한다.
  // <a download> 을 쓰지 않는 이유는 AttachmentLink 머리말 참고 — 그 방식은 서버가
  // 무엇을 돌려주든 파일로 저장해, 실패하면 오류 본문이 첨부 이름으로 저장된다.
  if (doc.doc_path === "" || doc.document_id <= 0) return <div style={style}>{inner}</div>;
  return (
    <AttachmentLink documentId={doc.document_id} fileName={doc.doc_name} style={style}>
      {inner}
    </AttachmentLink>
  );
}
