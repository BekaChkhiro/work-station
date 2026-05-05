// T4.13: Cross-session search registry.
//
// Terminal components register themselves on mount and unregister on cleanup.
// The CrossSessionSearch modal enumerates the registry to scan every live
// scrollback buffer at once. We keep this as a Solid store so the modal
// re-renders when sessions appear or disappear while it is open.
//
// The registry intentionally lives outside any component: cross-session
// search must reach into terminals that are mounted anywhere in the tree
// (current pane focus, future split panes, etc.) without prop drilling.

import { createStore, produce } from "solid-js/store";

export interface SessionEntry {
  id: string;
  title?: string;
  projectId?: string;
  /** Snapshot of the visible + scrollback buffer as line strings, in order. */
  getScrollback: () => string[];
  /** Reveal the given (0-based) buffer line in the owning pane and focus it. */
  focusLine: (line: number) => void;
}

interface SessionStore {
  sessions: SessionEntry[];
}

const [store, setStore] = createStore<SessionStore>({ sessions: [] });

export const sessionList = () => store.sessions;

export function registerSession(entry: SessionEntry): () => void {
  setStore(
    produce((s) => {
      // Replace any prior entry for the same id (re-mount during HMR / cycle).
      const idx = s.sessions.findIndex((e) => e.id === entry.id);
      if (idx >= 0) s.sessions[idx] = entry;
      else s.sessions.push(entry);
    }),
  );
  return () => {
    setStore(
      produce((s) => {
        const idx = s.sessions.findIndex((e) => e.id === entry.id);
        // Only remove if the registered entry is still the one we wrote —
        // a re-register during HMR may have replaced it already.
        if (idx >= 0 && s.sessions[idx] === entry) s.sessions.splice(idx, 1);
      }),
    );
  };
}
