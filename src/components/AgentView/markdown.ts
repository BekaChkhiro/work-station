// Lightweight Markdown → safe HTML for the Agent view's assistant messages.
//
// Hand-sanitised: the whole input is HTML-escaped first, then only trusted
// tags are re-introduced against the escaped text, so no regex ever sees raw
// user/model content. Output is meant for `innerHTML`; styling lives in
// `agentView.css` (`.agent-md` scope).
//
// Subset: ATX headings (#…###), fenced + inline code, bold, italic, links,
// unordered/ordered lists, blockquotes, and blank-line paragraphs. (Modelled
// on PlanFlowChat's renderer, extended with headings + links.)

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
  return input
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<a>$1</a>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
}

function renderTextBlock(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  let quote: string[] = [];

  const flushPara = (): void => {
    if (para.length > 0) {
      out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      const items = list.items.map((i) => `<li>${renderInline(i)}</li>`).join("");
      out.push(`<${list.type}>${items}</${list.type}>`);
      list = null;
    }
  };
  const flushQuote = (): void => {
    if (quote.length > 0) {
      out.push(`<blockquote>${quote.map(renderInline).join("<br>")}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = (): void => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.length === 0) {
      flushAll();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min((heading[1] ?? "").length, 3);
      out.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      flushQuote();
      if (list?.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(ul[1] ?? "");
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      flushQuote();
      if (list?.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ol[1] ?? "");
      continue;
    }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      flushPara();
      flushList();
      quote.push(bq[1] ?? "");
      continue;
    }
    flushList();
    flushQuote();
    para.push(line);
  }
  flushAll();
  return out.join("");
}

/** Translate Markdown-flavoured assistant text into sanitised HTML for
 *  `innerHTML`. */
export function renderAgentMarkdown(input: string): string {
  const escaped = escapeHtml(input);
  const blocks: string[] = [];
  const fence = /```([^`]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(escaped)) !== null) {
    if (match.index > cursor) {
      blocks.push(renderTextBlock(escaped.slice(cursor, match.index)));
    }
    const inner = (match[1] ?? "")
      .replace(/^[a-zA-Z0-9.+-]*\n/, "") // drop an optional ```lang line
      .replace(/\n$/, "");
    blocks.push(`<pre><code>${inner}</code></pre>`);
    cursor = match.index + match[0].length;
  }
  if (cursor < escaped.length) {
    blocks.push(renderTextBlock(escaped.slice(cursor)));
  }
  return blocks.join("");
}
