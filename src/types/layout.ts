/**
 * LayoutNode type system — Phase 5 (Tabs + Splits).
 *
 * A project's terminal layout is a recursive tree of splits and panes.
 * Each project owns exactly one root LayoutNode.
 */

import { z } from "zod";

/* ─── Primitives ─── */

export type SplitDirection = "horizontal" | "vertical";

export const splitDirectionSchema = z.enum(["horizontal", "vertical"]);

/* ─── Recursive node types ─── */

export interface LayoutSplitNode {
  type: "split";
  direction: SplitDirection;
  /** Ratio of the first child's size relative to the total (0–1). */
  ratio: number;
  children: LayoutNode[];
}

export interface LayoutPaneNode {
  type: "pane";
  /** Reference to a session row in the sessions table. */
  sessionId: string;
}

export type LayoutNode = LayoutSplitNode | LayoutPaneNode;

/* ─── Zod schemas (recursive) ─── */

export const layoutPaneNodeSchema = z.object({
  type: z.literal("pane"),
  sessionId: z.string().min(1),
});

export const layoutSplitNodeSchema: z.ZodType<LayoutSplitNode> = z.lazy(() =>
  z.object({
    type: z.literal("split"),
    direction: splitDirectionSchema,
    ratio: z.number().min(0.05).max(0.95),
    children: z.array(layoutNodeSchema).min(2),
  }),
);

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([layoutSplitNodeSchema, layoutPaneNodeSchema]),
);

/* ─── Type guards ─── */

export function isSplitNode(node: LayoutNode): node is LayoutSplitNode {
  return node.type === "split";
}

export function isPaneNode(node: LayoutNode): node is LayoutPaneNode {
  return node.type === "pane";
}

/* ─── Validation helpers ─── */

/** Parse untrusted data into a LayoutNode. Throws on invalid shape. */
export function parseLayoutNode(data: unknown): LayoutNode {
  return layoutNodeSchema.parse(data);
}

/** Safe-parse variant returning { success, data | error }. */
export function safeParseLayoutNode(
  data: unknown,
): ReturnType<typeof layoutNodeSchema.safeParse> {
  return layoutNodeSchema.safeParse(data);
}

/* ─── Tree traversal ─── */

export type LayoutVisitor = (node: LayoutNode, depth: number) => void;

/** Walk the layout tree depth-first (pre-order). */
export function walkLayoutNode(node: LayoutNode, visitor: LayoutVisitor, depth = 0): void {
  visitor(node, depth);
  if (isSplitNode(node)) {
    for (const child of node.children) {
      walkLayoutNode(child, visitor, depth + 1);
    }
  }
}

/** Collect every pane node in the tree. */
export function flattenPanes(node: LayoutNode): LayoutPaneNode[] {
  const panes: LayoutPaneNode[] = [];
  walkLayoutNode(node, (n) => {
    if (isPaneNode(n)) panes.push(n);
  });
  return panes;
}

/** Collect every sessionId referenced by pane nodes. */
export function getSessionIds(node: LayoutNode): string[] {
  return flattenPanes(node).map((p) => p.sessionId);
}
