// Minimal Markdown → HTML translator for the chat bubble. We render a
// strict subset because the assistant's output in this panel is short
// and plan-edit oriented — no diagrams, no tables, no images. The
// subset covers what users actually see in CLI chats:
//
//   * fenced code blocks (```…```)
//   * inline code (`code`)
//   * bold (**text**)
//   * italic (*text*)
//   * unordered list items (-, *)
//   * ordered list items (1.)
//   * blank-line paragraph breaks
//
// Output is sanitised by hand — we escape HTML at the very start, then
// only re-introduce trusted tags. No regex sees raw user content;
// every replacement runs against escaped text.

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESC[ch] ?? ch);
}

function renderInline(input: string): string {
  // Inline code first so the bold/italic regex doesn't eat tokens
  // inside a backtick span. The `[^`]` class is fine on already-
  // escaped text because backticks don't get HTML-encoded.
  return input
    .replace(/`([^`]+)`/g, '<code class="ws-pf-chat__md-code">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1<em>$2</em>");
}

/** Translate a Markdown-flavoured assistant message into safe HTML.
 *  Returns the HTML string ready to drop into `innerHTML`; the caller
 *  is responsible for picking a render path that injects via
 *  `innerHTML` rather than text content. */
export function renderChatMarkdown(input: string): string {
  const escaped = escapeHtml(input);
  const blocks: string[] = [];
  // Split on code fences first so the line-level pass below doesn't
  // mangle anything inside them.
  const fenceRegex = /```([^`]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(escaped)) !== null) {
    if (match.index > cursor) {
      blocks.push(renderTextBlock(escaped.slice(cursor, match.index)));
    }
    const inner = (match[1] ?? "").replace(/^\n/, "").replace(/\n$/, "");
    blocks.push(`<pre class="ws-pf-chat__md-pre"><code>${inner}</code></pre>`);
    cursor = match.index + match[0].length;
  }
  if (cursor < escaped.length) {
    blocks.push(renderTextBlock(escaped.slice(cursor)));
  }
  return blocks.join("");
}

function renderTextBlock(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  const flushList = (): void => {
    if (listType != null) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.length === 0) {
      flushList();
      out.push("");
      continue;
    }
    const ulMatch = line.match(/^\s*[-*]\s+(.*)$/);
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ulMatch) {
      if (listType !== "ul") {
        flushList();
        out.push('<ul class="ws-pf-chat__md-ul">');
        listType = "ul";
      }
      out.push(`<li>${renderInline(ulMatch[1] ?? "")}</li>`);
      continue;
    }
    if (olMatch) {
      if (listType !== "ol") {
        flushList();
        out.push('<ol class="ws-pf-chat__md-ol">');
        listType = "ol";
      }
      out.push(`<li>${renderInline(olMatch[1] ?? "")}</li>`);
      continue;
    }
    flushList();
    out.push(renderInline(line));
  }
  flushList();
  return (
    out
      .join("\n")
      .replace(/\n{2,}/g, "</p><p>")
      .replace(/^/, "<p>") + "</p>"
  );
}
