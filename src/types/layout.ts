// T5.1: LayoutNode type design.
//
// A tab's layout is a recursive tree of `split` interior nodes and `pane`
// leaves. Splits are always binary — the drag handle in T5.2 / `SplitPane`
// assumes exactly two children with a single `ratio` controlling how the
// available space divides. Multi-way splits are modelled by nesting.
//
// Schemas are authored here so the renderer (T5.4), persistence layer
// (T5.8 — `sessions.layout_json`), and IPC boundary all share one source of
// truth and round-trip cleanly through JSON.
//
// Acceptance (per PROJECT_PLAN T5.1): invalid layouts are rejected by
// `LayoutSchema.safeParse`; any value produced by the factories below
// re-parses to a structurally identical tree after `JSON.stringify` /
// `JSON.parse`.

import { z } from "zod";

export const SPLIT_DIRECTIONS = ["h", "v"] as const;
export type SplitDirection = (typeof SPLIT_DIRECTIONS)[number];

export const DEFAULT_SPLIT_RATIO = 0.5;

export const PaneNodeSchema = z.object({
  type: z.literal("pane"),
  sessionId: z.string().min(1),
});
export type PaneNode = z.infer<typeof PaneNodeSchema>;

export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  ratio: number;
  children: [LayoutNode, LayoutNode];
}

export type LayoutNode = PaneNode | SplitNode;

// Recursive schemas use `z.lazy` so the forward reference between
// `LayoutNodeSchema` and `SplitNodeSchema` resolves at parse time rather
// than module-load time.
export const SplitNodeSchema: z.ZodType<SplitNode> = z.lazy(() =>
  z.object({
    type: z.literal("split"),
    direction: z.enum(SPLIT_DIRECTIONS),
    // Ratio is the split fraction allocated to `children[0]`. The schema
    // accepts the full closed interval; runtime drag clamps a tighter
    // range (T5.2 enforces a 100px minimum per child).
    ratio: z.number().min(0).max(1),
    children: z.tuple([LayoutNodeSchema, LayoutNodeSchema]),
  }),
);

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([PaneNodeSchema, SplitNodeSchema]),
);

// A tab can exist with no panes mounted yet — represented as `{}` so a
// corrupt or absent `layout_json` row degrades to "no layout" instead of
// crashing the renderer. Kept as a distinct schema so the union below
// stays unambiguous (no overlap with pane/split shapes).
export const EmptyLayoutSchema = z.object({}).strict();
export type EmptyLayout = z.infer<typeof EmptyLayoutSchema>;

export const LayoutSchema = z.union([EmptyLayoutSchema, LayoutNodeSchema]);
export type Layout = z.infer<typeof LayoutSchema>;

export const EMPTY_LAYOUT: EmptyLayout = {};

export function paneNode(sessionId: string): PaneNode {
  return { type: "pane", sessionId };
}

export function splitNode(
  direction: SplitDirection,
  first: LayoutNode,
  second: LayoutNode,
  ratio: number = DEFAULT_SPLIT_RATIO,
): SplitNode {
  return { type: "split", direction, ratio, children: [first, second] };
}

export function isPane(node: LayoutNode): node is PaneNode {
  return node.type === "pane";
}

export function isSplit(node: LayoutNode): node is SplitNode {
  return node.type === "split";
}

export function isEmptyLayout(layout: Layout): layout is EmptyLayout {
  return !("type" in layout);
}

export function walkLayout(node: LayoutNode, visit: (node: LayoutNode) => void): void {
  visit(node);
  if (isSplit(node)) {
    walkLayout(node.children[0], visit);
    walkLayout(node.children[1], visit);
  }
}

export function collectPanes(node: LayoutNode): PaneNode[] {
  const out: PaneNode[] = [];
  walkLayout(node, (n) => {
    if (isPane(n)) out.push(n);
  });
  return out;
}

export function findPane(node: LayoutNode, sessionId: string): PaneNode | null {
  let found: PaneNode | null = null;
  walkLayout(node, (n) => {
    if (!found && isPane(n) && n.sessionId === sessionId) found = n;
  });
  return found;
}

export function serializeLayout(layout: Layout): string {
  return JSON.stringify(layout);
}

/** Parse a `sessions.layout_json` value. Returns `EMPTY_LAYOUT` on any failure. */
export function parseLayoutJson(raw: string | null | undefined): Layout {
  if (!raw) return EMPTY_LAYOUT;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return EMPTY_LAYOUT;
  }
  const result = LayoutSchema.safeParse(json);
  return result.success ? result.data : EMPTY_LAYOUT;
}
