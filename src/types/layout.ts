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

// Path encoding used by the renderer (T5.4) to identify a SplitNode by its
// position in the tree: empty string = root, "L"/"R" chars trace the
// child-of-child traversal. Stable across ratio changes — the LayoutTree
// passes the path back so the parent can update the right subtree.
export type LayoutPath = string;

/** Update the `ratio` on the SplitNode at `path`. Returns the original tree
 *  unchanged if the path doesn't resolve to a split, so subscribers can
 *  rely on referential equality to skip work. Untouched siblings keep
 *  their references — required by T5.4 so a ratio drag doesn't cascade
 *  remounts through Solid's reactive props. */
export function updateSplitRatio(node: LayoutNode, path: LayoutPath, ratio: number): LayoutNode {
  if (path === "") {
    if (!isSplit(node)) return node;
    if (node.ratio === ratio) return node;
    return { ...node, ratio };
  }
  if (!isSplit(node)) return node;
  const head = path[0];
  const rest = path.slice(1);
  const [left, right] = node.children;
  if (head === "L") {
    const next = updateSplitRatio(left, rest, ratio);
    if (next === left) return node;
    return { ...node, children: [next, right] };
  }
  if (head === "R") {
    const next = updateSplitRatio(right, rest, ratio);
    if (next === right) return node;
    return { ...node, children: [left, next] };
  }
  return node;
}

/** Locate the path to the pane with `sessionId`, in the same encoding as
 *  `updateSplitRatio` accepts. Returns `null` if no pane matches. Used by
 *  split / close actions (T5.6, T5.7) that operate on the "focused pane". */
export function findPanePath(node: LayoutNode, sessionId: string): LayoutPath | null {
  if (isPane(node)) return node.sessionId === sessionId ? "" : null;
  const left = findPanePath(node.children[0], sessionId);
  if (left !== null) return "L" + left;
  const right = findPanePath(node.children[1], sessionId);
  if (right !== null) return "R" + right;
  return null;
}

/** T5.6 — replace the pane with `targetSessionId` with a fresh SplitNode
 *  whose first child is the original pane and whose second child is a new
 *  pane wrapping `newSessionId`. Direction follows the tmux convention used
 *  throughout the layout module: `'h'` puts panes side-by-side (vertical
 *  separator), `'v'` stacks them (horizontal separator).
 *
 *  Returns the input tree unchanged (same reference) if `targetSessionId`
 *  isn't present. Untouched subtrees keep their references so the renderer
 *  (T5.4) doesn't remount unrelated panes when a sibling splits. */
export function splitPaneAt(
  node: LayoutNode,
  targetSessionId: string,
  direction: SplitDirection,
  newSessionId: string,
): LayoutNode {
  if (isPane(node)) {
    if (node.sessionId !== targetSessionId) return node;
    return splitNode(direction, node, paneNode(newSessionId));
  }
  const [left, right] = node.children;
  const nextLeft = splitPaneAt(left, targetSessionId, direction, newSessionId);
  if (nextLeft !== left) return { ...node, children: [nextLeft, right] };
  const nextRight = splitPaneAt(right, targetSessionId, direction, newSessionId);
  if (nextRight !== right) return { ...node, children: [left, nextRight] };
  return node;
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
