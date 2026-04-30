/**
 * Layout store — per-project tiling trees.
 *
 * Each project owns one root LayoutNode.  This store keeps the in-memory
 * mapping and provides actions to mutate it (split, close, replace, etc.).
 *
 * Layout persistence lives in the `sessions.layout_json` column for now;
 * this store is the reactive frontend mirror.
 */

import { createStore, produce } from "solid-js/store";
import type { LayoutNode, LayoutPaneNode, SplitDirection } from "../types/layout";

/* ─── State shape ─── */

interface LayoutState {
  /** projectId → root layout node */
  roots: Record<string, LayoutNode>;
  /** projectId → sessionId of the currently focused pane */
  activePaneId: Record<string, string | undefined>;
}

const [state, setState] = createStore<LayoutState>({
  roots: {},
  activePaneId: {},
});

/* ─── Read helpers ─── */

/** Get the root layout node for a project. */
export function getProjectLayout(projectId: string): LayoutNode | undefined {
  return state.roots[projectId];
}

/** Get the active pane sessionId for a project. */
export function getActivePaneId(projectId: string): string | undefined {
  return state.activePaneId[projectId];
}

/* ─── Write helpers ─── */

/** Set (or overwrite) the entire root layout for a project. */
export function setProjectLayout(projectId: string, root: LayoutNode): void {
  setState("roots", projectId, root);
}

/** Remove a project's layout from memory. */
export function clearProjectLayout(projectId: string): void {
  setState(
    produce((s) => {
      delete s.roots[projectId];
      delete s.activePaneId[projectId];
    }),
  );
}

/** Mark a pane as focused for a project. */
export function setActivePane(projectId: string, sessionId: string): void {
  setState("activePaneId", projectId, sessionId);
}

/* ─── Structural mutations ─── */

/**
 * Replace the first pane that matches `predicate` with a new sub-tree.
 * Returns `true` if a match was found and replaced.
 */
export function replacePane(
  projectId: string,
  predicate: (pane: LayoutPaneNode) => boolean,
  replacement: LayoutNode,
): boolean {
  const root = state.roots[projectId];
  if (!root) return false;

  const next = replaceInNode(root, predicate, replacement);
  if (next === root) return false;

  setState("roots", projectId, next);
  return true;
}

function replaceInNode(
  node: LayoutNode,
  predicate: (pane: LayoutPaneNode) => boolean,
  replacement: LayoutNode,
): LayoutNode {
  if (node.type === "pane") {
    return predicate(node) ? replacement : node;
  }

  const children = node.children.map((child) =>
    replaceInNode(child, predicate, replacement),
  );

  // short-circuit: no child changed
  if (children.every((c, i) => c === node.children[i])) {
    return node;
  }

  return { ...node, children };
}

/**
 * Split an existing pane into two panes side-by-side.
 * The original pane becomes a split node containing the old pane
 * and a new pane for the given session.
 */
export function splitPane(
  projectId: string,
  targetSessionId: string,
  direction: SplitDirection,
  newSessionId: string,
  ratio = 0.5,
): boolean {
  return replacePane(
    projectId,
    (pane) => pane.sessionId === targetSessionId,
    {
      type: "split",
      direction,
      ratio,
      children: [
        { type: "pane", sessionId: targetSessionId },
        { type: "pane", sessionId: newSessionId },
      ],
    },
  );
}

/**
 * Remove a pane from the layout tree.
 * If the pane lives inside a split with exactly two children, the split
 * collapses to the surviving child.
 */
export function removePane(projectId: string, sessionId: string): boolean {
  const root = state.roots[projectId];
  if (!root) return false;

  const next = removeFromNode(root, sessionId);
  if (next === undefined || next === root) return false;

  setState("roots", projectId, next);

  // clear focus if we just removed the active pane
  if (state.activePaneId[projectId] === sessionId) {
    setState("activePaneId", projectId, undefined);
  }

  return true;
}

function removeFromNode(node: LayoutNode, sessionId: string): LayoutNode | undefined {
  if (node.type === "pane") {
    return node.sessionId === sessionId ? undefined : node;
  }

  const children = node.children
    .map((child) => removeFromNode(child, sessionId))
    .filter((c): c is LayoutNode => c !== undefined);

  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];

  // short-circuit: no child changed
  if (children.every((c, i) => c === node.children[i])) {
    return node;
  }

  return { ...node, children };
}
