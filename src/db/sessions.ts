// Sessions DB helpers — re-exports the layout schema for the
// `sessions.layout_json` column and provides the T5.8 persister.
//
// T3.3: layout_json is a TEXT column in SQLite (see migrations/0002_sessions.sql)
// holding a JSON-encoded layout tree. T5.1 promoted the schema to its own
// module (`src/types/layout.ts`) so the renderer (T5.4) and persistence
// helpers can share one source of truth.
//
// T5.8: writes are validated through `LayoutSchema` BEFORE hitting SQLite —
// a malformed layout (e.g. a half-built tree captured mid-mutation) is
// rejected and the existing row keeps its previous valid value. Each save
// is a single `UPDATE` statement, which SQLite executes atomically, so a
// crash between debounce flushes can never leave a partial row. The acceptance
// for T5.8 ("mid-resize crash leaves valid (older) layout in DB") follows
// from those two properties + the debounce: rapid ratio drags coalesce into
// one write per 500ms, and any in-flight write either lands wholly or not
// at all.

import {
  EMPTY_LAYOUT,
  LayoutSchema,
  parseLayoutJson,
  serializeLayout,
  type Layout,
} from "../types/layout";
import { db } from "./index";

export {
  EMPTY_LAYOUT,
  EmptyLayoutSchema,
  LayoutSchema,
  PaneNodeSchema,
  parseLayoutJson as parseLayout,
} from "../types/layout";
export type { EmptyLayout, Layout, PaneNode } from "../types/layout";

/** T5.8 default debounce window. Matches the project plan (500ms). */
export const LAYOUT_PERSIST_DEBOUNCE_MS = 500;

/**
 * Persist a layout for a single session. Validates the layout against
 * `LayoutSchema` first — invalid input throws synchronously and the DB row
 * is left untouched. The write itself is one atomic `UPDATE` statement;
 * SQLite guarantees no torn writes, so a crash mid-call leaves either the
 * old row or the new one, never a partial JSON blob.
 *
 * Throws `z.ZodError` for invalid layouts and re-throws DB errors.
 */
export async function saveSessionLayout(sessionId: string, layout: Layout): Promise<void> {
  const validated = LayoutSchema.parse(layout);
  const handle = await db();
  await handle.execute("UPDATE sessions SET layout_json = ?1 WHERE id = ?2", [
    serializeLayout(validated),
    sessionId,
  ]);
}

export interface LayoutPersister {
  /** Schedule a save after the debounce window. Subsequent calls within
   *  the window replace the pending value; only the latest layout is
   *  written. Returns immediately — failures are reported via `onError`. */
  schedule: (layout: Layout) => void;
  /** Force any pending save to run immediately. Resolves after the write
   *  completes (or rejects with the underlying error). No-op if nothing
   *  is pending. */
  flush: () => Promise<void>;
  /** Drop any pending save without writing. Useful when the owning
   *  component unmounts and the session is being torn down. */
  cancel: () => void;
}

export interface LayoutPersisterOptions {
  /** Debounce window in milliseconds. Defaults to `LAYOUT_PERSIST_DEBOUNCE_MS`. */
  debounceMs?: number;
  /** Reported when a debounced flush fails. The persister keeps running —
   *  later schedules can succeed even after a transient DB error. */
  onError?: (error: unknown) => void;
}

/**
 * Build a debounced persister bound to a single `sessionId`.
 *
 * Caller contract: invoke `schedule(layout)` on every layout mutation
 * (ratio drag, split, close). The persister coalesces bursts into one
 * write per `debounceMs` window. Call `flush()` from a graceful-shutdown
 * path so an in-flight debounce isn't lost on app close, and `cancel()`
 * when the session is being deleted to stop a final stale write.
 *
 * The persister never throws from `schedule` — validation/DB errors are
 * routed through `onError` so a bad transient state doesn't crash the
 * caller's update loop. `flush()` *does* throw, because callers waiting
 * on shutdown need to know whether the final write succeeded.
 */
interface ProjectSessionRow {
  id: string;
  layout_json: string;
}

/**
 * T2.12 — get or create the persistent session row for `projectId`.
 *
 * Returns the most recent session's id and its persisted layout. If no
 * session row exists yet (first launch for this project), inserts a new row
 * with an empty layout and returns that id + `EMPTY_LAYOUT`.
 *
 * Callers pass `cli` / `cwd` only so the newly-created row carries context
 * that is useful for debugging; the actual layout restore uses the project's
 * live metadata, not the stored cli/cwd strings.
 */
export async function getOrCreateProjectSession(
  projectId: string,
  cli: string | null,
  cwd: string | null,
): Promise<{ id: string; layout: Layout }> {
  const handle = await db();
  const rows = await handle.select<ProjectSessionRow[]>(
    "SELECT id, layout_json FROM sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    [projectId],
  );
  const row = rows[0];
  if (row) return { id: row.id, layout: parseLayoutJson(row.layout_json) };
  const id = crypto.randomUUID();
  await handle.execute(
    "INSERT INTO sessions (id, project_id, title, cli, cwd, layout_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, projectId, "main", cli, cwd, "{}", Math.floor(Date.now() / 1000)],
  );
  return { id, layout: EMPTY_LAYOUT };
}

export function createLayoutPersister(
  sessionId: string,
  options: LayoutPersisterOptions = {},
): LayoutPersister {
  const debounceMs = options.debounceMs ?? LAYOUT_PERSIST_DEBOUNCE_MS;
  const onError = options.onError;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Layout | null = null;

  const runWrite = async (layout: Layout): Promise<void> => {
    await saveSessionLayout(sessionId, layout);
  };

  const fireDebounced = (): void => {
    timer = null;
    const layout = pending;
    pending = null;
    if (layout === null) return;
    runWrite(layout).catch((error: unknown) => {
      onError?.(error);
    });
  };

  return {
    schedule(layout) {
      pending = layout;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fireDebounced, debounceMs);
    },
    async flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const layout = pending;
      pending = null;
      if (layout === null) return;
      await runWrite(layout);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
