import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  getCase, isClosedStatus, listAttachments, listThreads, markCaseRead,
  type AttachmentViewRow,
} from "../../../lib/queries.ts";
import { Badge, COLOR, Card, MONO_STACK, RADIUS, formatStamp, statusColors } from "../../ui.tsx";
import { ReplyBox } from "./ReplyBox.tsx";
import { SummaryPanel } from "./SummaryPanel.tsx";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const requestId = Number(id);
  if (!Number.isFinite(requestId)) notFound();

  const detail = getCase(requestId);
  if (detail === null) notFound();

  const threads = listThreads(requestId);
  const attachments = listAttachments(requestId);
  markCaseRead(requestId);

  const closed = isClosedStatus(detail.status);
  const tone = statusColors(detail.status);

  const byThread = new Map<number, AttachmentViewRow[]>();
  for (const doc of attachments) {
    const key = doc.thread_id ?? 0;
    byThread.set(key, [...(byThread.get(key) ?? []), doc]);
  }

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
        </div>
      </header>

      {closed && <SummaryPanel requestId={detail.request_id} />}

      <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
        <section style={{ flex: 1, minWidth: 0 }}>
          {detail.description_text !== "" && (
            <Card style={{ padding: "18px 20px", marginBottom: 14 }}>
              <SpeakerRow ours label="최초 등록 내용" at={formatStamp(detail.created_on_ms)} />
              <Body text={detail.description_text} />
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
                <Body text={thread.body_text} />
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

function Body({ text }: { text: string }) {
  return (
    <p style={{
      margin: 0, fontSize: 14, lineHeight: 1.75, color: COLOR.body,
      whiteSpace: "pre-wrap", wordBreak: "break-word",
    }}>
      {text === "" ? "(본문 없음)" : text}
    </p>
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

  if (doc.doc_path === "") return <div style={style}>{inner}</div>;
  return <a href={doc.doc_path} target="_blank" rel="noreferrer" style={style}>{inner}</a>;
}
