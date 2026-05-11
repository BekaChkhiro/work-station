// Per-project chat session list — the rows backing the tab strip in
// the PlanFlow chat panel. Each tab is one session: a saved CLI
// preference + display name. The live PTY processes live in the
// `planflowChatSessions` runtime store (src/stores) and aren't kept
// here because they don't outlive the app.
//
// Access pattern is per-project list + per-row CRUD. We use
// tauri-plugin-sql directly because there are no cross-row
// invariants to enforce in Rust.

import { z } from "zod";

import { db } from "./index";

export const ChatSessionRowSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  cliId: z.string().nullable(),
  name: z.string(),
  createdAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
});
export type ChatSessionRow = z.infer<typeof ChatSessionRowSchema>;

interface DbRow {
  id: string;
  project_id: string;
  cli_id: string | null;
  name: string;
  created_at: number;
  last_active_at: number;
}

function fromDb(row: DbRow): ChatSessionRow {
  return {
    id: row.id,
    projectId: row.project_id,
    cliId: row.cli_id,
    name: row.name,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

/** Newest-first per `last_active_at` so reopening the panel lands on
 *  the tab the user was most recently working in. */
export async function listChatSessions(projectId: string): Promise<ChatSessionRow[]> {
  const handle = await db();
  const rows = await handle.select<DbRow[]>(
    "SELECT id, project_id, cli_id, name, created_at, last_active_at \
     FROM planflow_chat_sessions WHERE project_id = ?1 \
     ORDER BY last_active_at DESC",
    [projectId],
  );
  return rows.map(fromDb);
}

export interface CreateChatSessionInput {
  id: string;
  projectId: string;
  cliId: string | null;
  name: string;
}

export async function createChatSession(input: CreateChatSessionInput): Promise<ChatSessionRow> {
  const now = Date.now();
  const handle = await db();
  await handle.execute(
    "INSERT INTO planflow_chat_sessions (id, project_id, cli_id, name, created_at, last_active_at) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
    [input.id, input.projectId, input.cliId, input.name, now],
  );
  return {
    id: input.id,
    projectId: input.projectId,
    cliId: input.cliId,
    name: input.name,
    createdAt: now,
    lastActiveAt: now,
  };
}

export async function renameChatSession(id: string, name: string): Promise<void> {
  const handle = await db();
  await handle.execute(
    "UPDATE planflow_chat_sessions SET name = ?1, last_active_at = ?2 WHERE id = ?3",
    [name, Date.now(), id],
  );
}

export async function touchChatSession(id: string, cliId?: string | null): Promise<void> {
  const handle = await db();
  if (cliId !== undefined) {
    await handle.execute(
      "UPDATE planflow_chat_sessions SET cli_id = ?1, last_active_at = ?2 WHERE id = ?3",
      [cliId, Date.now(), id],
    );
    return;
  }
  await handle.execute("UPDATE planflow_chat_sessions SET last_active_at = ?1 WHERE id = ?2", [
    Date.now(),
    id,
  ]);
}

export async function deleteChatSession(id: string): Promise<void> {
  const handle = await db();
  await handle.execute("DELETE FROM planflow_chat_sessions WHERE id = ?1", [id]);
}
