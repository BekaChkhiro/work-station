// Cmd/Ctrl + Alt + Arrow → move focus to the neighboring pane in that
// direction within the active project. Geometry-based: we read each
// pane's bounding rect from the DOM and pick the closest candidate that
// lies on the requested side of the current focus, scoring by axis
// distance plus a small cross-axis penalty so a stacked sibling beats a
// distant pane that happens to overlap by one row.
//
// Listens at the document level so xterm's hidden textarea doesn't
// swallow the keystroke. Terminal.tsx returns false from
// `attachCustomKeyEventHandler` for this combo so the shell never
// receives the arrow either.

import { onCleanup, onMount } from "solid-js";
import { sessionList } from "../stores/sessions";
import { activeProjectId, getWorkspace, setFocusedSession } from "../stores/workspace";
import { collectPanes } from "../types/layout";
import { eventMatchesBinding, getBinding } from "./registry";

type Dir = "left" | "right" | "up" | "down";

const NAV_ACTION_IDS: readonly (readonly [Dir, string])[] = [
  ["left", "pane-nav-left"],
  ["right", "pane-nav-right"],
  ["up", "pane-nav-up"],
  ["down", "pane-nav-down"],
];

interface PaneRect {
  sessionId: string;
  rect: DOMRect;
}

const readPaneRects = (projectId: string): PaneRect[] => {
  const ws = getWorkspace(projectId);
  if (!ws || !ws.layout) return [];
  const ids = collectPanes(ws.layout).map((p) => p.sessionId);
  const out: PaneRect[] = [];
  // Scope the query to the active project's workspace block to avoid
  // matching offscreen `.ws-pane` nodes from other projects (every project's
  // tree is mounted at all times — only the active one is `display: flex`).
  const scope = document.querySelector(
    `[data-project-id="${CSS.escape(projectId)}"][data-active="true"]`,
  );
  if (!scope) return [];
  for (const id of ids) {
    const el = scope.querySelector(`.ws-pane[data-session-id="${CSS.escape(id)}"]`);
    if (!el) continue;
    out.push({ sessionId: id, rect: el.getBoundingClientRect() });
  }
  return out;
};

const SAME_AXIS_TOL = 4; // px — treat tiny overlaps as "on the same row/column"

const pickNeighbor = (panes: PaneRect[], focusedId: string, dir: Dir): string | null => {
  const me = panes.find((p) => p.sessionId === focusedId);
  if (!me) return null;
  const myCx = (me.rect.left + me.rect.right) / 2;
  const myCy = (me.rect.top + me.rect.bottom) / 2;

  let best: { id: string; score: number } | null = null;
  for (const cand of panes) {
    if (cand.sessionId === focusedId) continue;
    const cx = (cand.rect.left + cand.rect.right) / 2;
    const cy = (cand.rect.top + cand.rect.bottom) / 2;

    let onSide = false;
    let primary = 0; // distance along the navigation axis
    let cross = 0; // misalignment on the perpendicular axis
    switch (dir) {
      case "left":
        onSide = cand.rect.right <= me.rect.left + SAME_AXIS_TOL;
        primary = me.rect.left - cand.rect.right;
        cross = Math.abs(cy - myCy);
        break;
      case "right":
        onSide = cand.rect.left >= me.rect.right - SAME_AXIS_TOL;
        primary = cand.rect.left - me.rect.right;
        cross = Math.abs(cy - myCy);
        break;
      case "up":
        onSide = cand.rect.bottom <= me.rect.top + SAME_AXIS_TOL;
        primary = me.rect.top - cand.rect.bottom;
        cross = Math.abs(cx - myCx);
        break;
      case "down":
        onSide = cand.rect.top >= me.rect.bottom - SAME_AXIS_TOL;
        primary = cand.rect.top - me.rect.bottom;
        cross = Math.abs(cx - myCx);
        break;
    }
    if (!onSide) continue;
    // Cross-axis penalty (×2) keeps a slightly-misaligned direct neighbor
    // ahead of a distant pane that happens to share an edge.
    const score = Math.max(0, primary) + cross * 2;
    if (best === null || score < best.score) {
      best = { id: cand.sessionId, score };
    }
  }
  return best?.id ?? null;
};

const matchedDir = (e: KeyboardEvent): Dir | null => {
  for (const [dir, id] of NAV_ACTION_IDS) {
    const binding = getBinding(id);
    if (binding && eventMatchesBinding(e, binding)) return dir;
  }
  return null;
};

export function installPaneNavHotkeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const dir = matchedDir(e);
    if (!dir) return;
    const projectId = activeProjectId();
    if (!projectId) return;
    const ws = getWorkspace(projectId);
    if (!ws || !ws.focusedSessionId || !ws.layout) return;
    const panes = readPaneRects(projectId);
    if (panes.length < 2) return;
    const next = pickNeighbor(panes, ws.focusedSessionId, dir);
    if (!next) return;
    e.preventDefault();
    setFocusedSession(projectId, next);
    // Move keyboard focus into the new terminal so the user can type
    // immediately — mirrors the project-switch refocus behavior.
    queueMicrotask(() => {
      const entry = sessionList().find((s) => s.id === next);
      entry?.focus();
    });
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}

export function usePaneNavHotkeys(): void {
  onMount(() => {
    const dispose = installPaneNavHotkeys();
    onCleanup(dispose);
  });
}
