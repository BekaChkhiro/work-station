// T18.16 — desktop-side listener for mobile-originated PlanFlow chat.
//
// The mobile PWA sends chat messages over the WebSocket bridge (see
// `src-tauri/src/ws/chat_bridge.rs`). The server persists them to the
// `planflow_chats` table and fires a Tauri event with `{ projectId,
// content }` so this listener can route the message into the live
// PlanFlow chat panel — making it "appear" in the desktop chat as the
// acceptance criterion requires.
//
// Lookup chain on receipt:
//   1. Resolve the workspace projectId from the PlanFlow external UUID
//      via `project_links` (service = "planflow"). The mobile sends the
//      external UUID because that's what its Tasks view uses; the
//      desktop chat panel is keyed on the workspace projectId.
//   2. Pull the active chat session row for that workspace project from
//      the prefs store (mirrors what the desktop panel itself does).
//   3. Look up the live PTY runtime for that session row. If the panel
//      hasn't been opened (cold session after a restart), there's no
//      PTY to write to — surface a console warning rather than silently
//      drop, so the user can spot the issue.
//   4. `ptyWrite(sessionId, "<content>\r")` injects the message just
//      like a keystroke would.
//
// The listener is mounted once during AppRoot boot and torn down on app
// exit via the returned disposer.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { ptyWrite } from "../../ipc/pty";
import { chatActiveSessionId } from "../../stores/planflowChatPrefs";
import { planflowChatRuntime } from "../../stores/planflowChatSessions";
import { listProjectLinks, Integration } from "../../db/projectLinks";
import { listProjects } from "../../db/projects";

/** Wire name of the Tauri event — must match
 *  `PLANFLOW_CHAT_MESSAGE_EVENT` in `ws/projects_bridge.rs`. */
const EVENT_NAME = "planflow-chat-mobile-message";

interface ChatPayload {
  projectId: string;
  content: string;
}

async function resolveWorkspaceProjectId(externalId: string): Promise<string | null> {
  // The project_links table doesn't expose a reverse lookup helper, so
  // walk the workspace projects and check each for a matching link.
  // The list is small (handful of projects per user); a full scan is
  // fine and saves us a custom Tauri command.
  const projects = await listProjects();
  for (const project of projects) {
    try {
      const links = await listProjectLinks(project.id);
      if (links.some((l) => l.service === Integration.PlanFlow && l.externalId === externalId)) {
        return project.id;
      }
    } catch {
      // Ignore — keep scanning. Worst case nothing matches.
    }
  }
  return null;
}

async function handleIncoming(payload: ChatPayload): Promise<void> {
  const trimmed = payload.content?.trim() ?? "";
  if (trimmed.length === 0) return;

  // The mobile side ships the PlanFlow external UUID in `projectId`;
  // the desktop chat panel is keyed on the workspace projectId. If the
  // payload happens to already be a workspace projectId (a future
  // version of the mobile client could send it directly) we still try
  // the lookup but fall through to treating the payload as canonical.
  const workspaceId = (await resolveWorkspaceProjectId(payload.projectId)) ?? payload.projectId;

  const rowId = chatActiveSessionId(workspaceId);
  if (rowId == null) {
    console.warn(
      "[planflow-chat] mobile message received but no active session for project",
      workspaceId,
    );
    return;
  }
  const runtime = planflowChatRuntime(rowId);
  if (runtime == null) {
    console.warn(
      "[planflow-chat] mobile message received but PTY runtime is not live for session",
      rowId,
    );
    return;
  }

  // CR submits the buffer in Ink-based TUIs (Claude Code et al). Embedded
  // newlines stay LF so shift-enter equivalents work for multi-line input.
  const body = trimmed.replace(/\r/g, "");
  const payloadBytes = new TextEncoder().encode(`${body}\r`);
  try {
    await ptyWrite(runtime.sessionId, payloadBytes);
  } catch (error) {
    console.warn("[planflow-chat] failed to write mobile message into PTY", error);
  }
}

/** Wire up the listener. Returns a disposer that AppRoot calls on cleanup. */
export async function installChatMobileListener(): Promise<UnlistenFn> {
  return listen<ChatPayload>(EVENT_NAME, (event) => {
    void handleIncoming(event.payload);
  });
}
