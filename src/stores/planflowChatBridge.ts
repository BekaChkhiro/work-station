// Bridge between the PlanFlow chat widget (UI) and the future hidden-PTY
// transport. The chat component sends user messages via `sendChatMessage`;
// Phase 2 registers a stub that just echoes a placeholder so the panel is
// usable for layout review. Phase 3 (hidden PTY) replaces the bridge with
// the real PTY pipe and the UI stays untouched.
//
// The bridge also exposes lifecycle hooks (`startSession`, `endSession`)
// so the PTY layer can spin up a CLI process when the panel first opens
// for a project and tear it down when the user clears the chat or
// switches CLI. Phase 2's stub is a no-op for both.
//
// Pattern matches `taskCliLauncher`: AppRoot registers the implementation
// on boot; the UI imports the call-through functions.

import type { ToolCall } from "../db/planflowChats";

export interface SendChatMessageInput {
  /** Workspace projectId — the local row the chat is bound to. */
  projectId: string;
  /** PlanFlow project UUID, from project_links. The CLI needs both so
   *  it can call `planflow_*` MCP tools against the right project. */
  externalId: string;
  /** Selected CLI id ("claude", "kimi", "codex"). The bridge spawns
   *  a new session when this changes mid-conversation. */
  cliId: string;
  /** Raw user message text. */
  content: string;
}

export interface ChatSessionResult {
  /** Final assistant content rendered as a single message bubble. */
  content: string;
  /** Tool invocations the assistant made during this turn. Phase 5
   *  renders these as inline chips. Phase 2's stub returns `null`. */
  toolCalls?: ToolCall[] | null;
}

export type ChatSender = (input: SendChatMessageInput) => Promise<ChatSessionResult>;
export type ChatLifecycleHook = (projectId: string, cliId: string) => Promise<void> | void;

let registeredSender: ChatSender | null = null;
let registeredStartSession: ChatLifecycleHook | null = null;
let registeredEndSession: ChatLifecycleHook | null = null;

/** AppRoot (Phase 3) calls this with the PTY-backed implementation.
 *  Pass `null` from `onCleanup` to break the closure on HMR. */
export function setChatBridge(input: {
  sender: ChatSender | null;
  startSession?: ChatLifecycleHook | null;
  endSession?: ChatLifecycleHook | null;
}): void {
  registeredSender = input.sender;
  registeredStartSession = input.startSession ?? null;
  registeredEndSession = input.endSession ?? null;
}

/** Returns true when the bridge has a real sender wired. The UI uses
 *  this to disable the send button + show a tooltip when the CLI
 *  transport isn't ready (Phase 2 default). */
export function hasChatBridge(): boolean {
  return registeredSender !== null;
}

/** Send a message to the registered CLI session. Throws when no bridge
 *  has been registered yet so the caller can surface a Phase-2-style
 *  placeholder. */
export async function sendChatMessage(input: SendChatMessageInput): Promise<ChatSessionResult> {
  if (registeredSender == null) {
    throw new Error("Chat bridge not registered — Phase 3 wiring pending.");
  }
  return registeredSender(input);
}

/** Best-effort: notify the bridge that a session should be brought up
 *  for `(projectId, cliId)`. The widget calls this when first expanded
 *  or when the user changes CLI. Errors are logged + swallowed; the
 *  send flow will surface the real failure on first message. */
export async function startChatSession(projectId: string, cliId: string): Promise<void> {
  const fn = registeredStartSession;
  if (fn == null) return;
  try {
    await fn(projectId, cliId);
  } catch (error) {
    console.warn("[planflow-chat] startSession failed:", error);
  }
}

export async function endChatSession(projectId: string, cliId: string): Promise<void> {
  const fn = registeredEndSession;
  if (fn == null) return;
  try {
    await fn(projectId, cliId);
  } catch (error) {
    console.warn("[planflow-chat] endSession failed:", error);
  }
}
