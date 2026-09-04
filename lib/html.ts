/**
 * 답변 본문을 포털 에디터가 만드는 형태의 HTML 로 바꾼다.
 * server-only 밖에 두어 테스트할 수 있게 한다.
 */
export function textToHtml(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const body = paragraphs
    .map((block) => {
      const lines = block.split("\n").map((l) => escape(l.trim())).filter((l) => l !== "");
      if (lines.length === 0) return "";
      return `<p dir="ltr"><span style="white-space: pre-wrap;">${lines.join("<br>")}</span></p>`;
    })
    .filter((p) => p !== "")
    .join('<p dir="ltr">&nbsp;</p>');
  return `<div>${body}</div>`;
}
