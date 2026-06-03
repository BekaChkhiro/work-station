// Typed wrappers for the Agent (Claude Code `stream-json`) IPC surface.
//
// POC counterpart to `ipc/pty.ts`: instead of raw PTY bytes, the backend
// drives `claude` in bidirectional `stream-json` mode and forwards each
// newline-delimited JSON event as a string over a `tauri::ipc::Channel`.
// The `AgentView` component parses those strings into chat / tool-call /
// diff items.
//
// Local-only by design — this is a dev test surface (`?wsdebug=agent-test`)
// and deliberately does NOT route through the cloud transport the way
// `ipc/pty.ts` does. Outside the Tauri runtime every call is a no-op so the
// component can mount in a plain browser tab without a backend.

import { Channel, invoke } from "@tauri-apps/api/core";

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface AgentSpawnArgs {
  /** Binary to launch. Defaults to `claude` on the Rust side when omitted. */
  command?: string;
  /** Working directory for the agent. */
  cwd?: string;
  /** `--permission-mode`: `default` | `acceptEdits` | `bypassPermissions` | `plan` | `dontAsk`. */
  permissionMode?: string;
  /** Optional `--model` override. */
  model?: string;
  /** First user turn, written to stdin right after spawn. */
  initialPrompt?: string;
  /** Claude session id to resume (`--resume`). */
  resume?: string;
}

export interface AgentSpawnResponse {
  sessionId: string;
}

/** Handler for one raw stream-json event line (already a JSON string). */
export type AgentEventHandler = (line: string) => void;

export interface AgentHandle extends AgentSpawnResponse {
  /** Detach the event channel. The backend reader exits on next send. */
  dispose: () => void;
}

/**
 * Spawn a Claude Code stream-json session. `onEvent` fires once per stdout
 * line (plus the synthetic `_stderr` / `_closed` envelopes the backend
 * adds). Rejects when the Tauri runtime is unavailable so the harness can
 * surface a "run inside the Tauri window" hint.
 */
export async function agentSpawn(
  args: AgentSpawnArgs,
  onEvent: AgentEventHandler,
): Promise<AgentHandle> {
  if (!isTauriRuntime()) {
    throw new Error(
      "Agent commands need the Tauri window (the one `pnpm tauri dev` launches), not a plain browser tab.",
    );
  }

  let handler: AgentEventHandler | null = onEvent;
  const channel = new Channel<string>((line) => {
    if (handler) handler(line);
  });

  const resp = await invoke<AgentSpawnResponse>("agent_spawn", {
    args,
    onEvent: channel,
  });

  return {
    sessionId: resp.sessionId,
    dispose: () => {
      handler = null;
      channel.onmessage = () => undefined;
    },
  };
}

/** Send a follow-up user turn to a running session. */
export async function agentWrite(sessionId: string, text: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("agent_write", { args: { sessionId, text } });
}

/** Interrupt the current turn without ending the session. */
export async function agentInterrupt(sessionId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("agent_interrupt", { args: { sessionId } });
}

/** Terminate a running session. Safe to call repeatedly. */
export async function agentKill(sessionId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("agent_kill", { args: { sessionId } });
}
