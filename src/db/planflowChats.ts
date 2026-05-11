// PlanFlow chat — per-project, scoped CLI chat for plan/task edits.
//
// The floating chat widget at the bottom-right of the PlanFlow tab
// pipes the user's messages to a hidden PTY running the project's
// chosen CLI, with planflow-mcp tools loaded. We persist the full
// transcript per project so the conversation survives an app restart
// (and so we can show the recent context on first paint without
// waiting on the CLI to print a banner).
//
// Schema lives in `src-tauri/migrations/0009_planflow_chats.sql`.
// The TypeScript layer uses tauri-plugin-sql directly because the
// access pattern is a single project's append-only log — no
// invariants worth a custom Rust command.

import { z } from "zod";

import { db } from "./index";

/** Roles the chat widget understands. `system` rows hold the bootstrap
 *  prompt + project context that the renderer paints as a faint
 *  banner above the first user turn. `tool` is reserved for future
 *  tool-call rendering (Phase 5). */
export const ChatRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ChatMessageSchema = z.object({
  id: z.number().int().nonnegative(),
  projectId: z.string().min(1),
  role: ChatRoleSchema,
  content: z.string(),
  cli: z.string().nullable(),
  toolCalls: z.array(ToolCallSchema).nullable(),
  createdAt: z.number().int().nonnegative(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

interface ChatRow {
  id: number;
  project_id: string;
  role: string;
  content: string;
  cli: string | null;
  tool_calls_json: string | null;
  created_at: number;
}

function parseToolCalls(raw: string | null): ToolCall[] | null {
  if (raw == null || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = z.array(ToolCallSchema).safeParse(parsed);
    return list.success ? list.data : null;
  } catch {
    return null;
  }
}

function rowToMessage(row: ChatRow): ChatMessage {
  const role = ChatRoleSchema.parse(row.role);
  return {
    id: row.id,
    projectId: row.project_id,
    role,
    content: row.content,
    cli: row.cli,
    toolCalls: parseToolCalls(row.tool_calls_json),
    createdAt: row.created_at,
  };
}

/** Load the full transcript for a project, oldest-first. Trims the
 *  result to the most recent `limit` rows (default 200) so a long
 *  conversation doesn't drag the chat panel's first paint. The widget
 *  exposes a "Load older" affordance for pre-window history. */
export async function loadChatHistory(projectId: string, limit = 200): Promise<ChatMessage[]> {
  const handle = await db();
  const rows = await handle.select<ChatRow[]>(
    "SELECT id, project_id, role, content, cli, tool_calls_json, created_at \
     FROM planflow_chats WHERE project_id = ?1 \
     ORDER BY id DESC LIMIT ?2",
    [projectId, limit],
  );
  return rows.map(rowToMessage).reverse();
}

export interface AppendChatMessageInput {
  projectId: string;
  role: ChatRole;
  content: string;
  cli?: string | null;
  toolCalls?: ToolCall[] | null;
}

/** Append a message to a project's transcript. Returns the inserted
 *  row's id + timestamp so the renderer can echo the row optimistically
 *  without a re-fetch. */
export async function appendChatMessage(input: AppendChatMessageInput): Promise<ChatMessage> {
  const createdAt = Date.now();
  const handle = await db();
  const toolCallsJson =
    input.toolCalls && input.toolCalls.length > 0 ? JSON.stringify(input.toolCalls) : null;
  const result = await handle.execute(
    "INSERT INTO planflow_chats (project_id, role, content, cli, tool_calls_json, created_at) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [input.projectId, input.role, input.content, input.cli ?? null, toolCallsJson, createdAt],
  );
  return {
    id: Number(result.lastInsertId ?? 0),
    projectId: input.projectId,
    role: input.role,
    content: input.content,
    cli: input.cli ?? null,
    toolCalls: input.toolCalls ?? null,
    createdAt,
  };
}

/** Wipe a project's transcript. Returns the number of rows deleted so
 *  the UI can show a confirmation toast ("Cleared 14 messages."). */
export async function clearChatHistory(projectId: string): Promise<number> {
  const handle = await db();
  const result = await handle.execute("DELETE FROM planflow_chats WHERE project_id = ?1", [
    projectId,
  ]);
  return Number(result.rowsAffected ?? 0);
}
