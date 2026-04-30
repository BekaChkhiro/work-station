// IPC channel types and helpers

import { Channel, invoke } from "@tauri-apps/api/core";
import { readText as clipboardReadText } from "@tauri-apps/plugin-clipboard-manager";

/** A saved project that maps to a directory on disk. */
export interface Project {
  id: string;
  name: string;
  path: string;
  color: string | null;
  icon: string | null;
  default_cli: string | null;
  env_json: string | null;
  position: number;
  created_at: string;
}

/** Metadata for an active PTY session. */
export interface SessionInfo {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  created_at: number;
}

/** A persisted session stored in the database. */
export interface Session {
  id: string;
  project_id: string;
  title: string | null;
  cli: string | null;
  cwd: string | null;
  layout_json: string | null;
  created_at: number;
}

/**
 * Create a binary channel for receiving PTY output.
 *
 * Tauri v2 sends `InvokeResponseBody::Raw` as either:
 * - A `Uint8Array` for small payloads (< 1024 bytes, via eval)
 * - An `ArrayBuffer` for large payloads (via fetch API)
 *
 * This normalises both to a `Uint8Array`.
 */
export function createPtyChannel(onData: (data: Uint8Array) => void): Channel<Uint8Array> {
  return new Channel<Uint8Array>((response) => {
    // Response arrives as either ArrayBuffer (fetch path) or Uint8Array (eval path)
    if (response instanceof ArrayBuffer) {
      onData(new Uint8Array(response));
    } else if (response instanceof Uint8Array) {
      onData(response);
    } else if (typeof response === "object" && response !== null && "message" in response) {
      // Handle possible wrapper shape from Tauri internals
      const msg = (response as { message: unknown }).message;
      if (msg instanceof ArrayBuffer) {
        onData(new Uint8Array(msg));
      } else if (msg instanceof Uint8Array) {
        onData(msg);
      }
    }
  });
}

/**
 * Spawn a new PTY session.
 *
 * @param cwd     – working directory
 * @param command – shell/command to execute
 * @param env     – environment variables map
 * @param cols    – terminal width
 * @param rows    – terminal height
 * @returns the session UUID
 */
export async function ptySpawn(
  cwd: string,
  command: string,
  env: Record<string, string>,
  cols: number,
  rows: number
): Promise<string> {
  return invoke("pty_spawn", { cwd, command, env, cols, rows });
}

/**
 * List all active PTY sessions.
 *
 * Use this after a frontend reload to discover surviving sessions.
 */
export async function ptyList(): Promise<SessionInfo[]> {
  return invoke("pty_list");
}

/**
 * Get metadata for a single PTY session.
 *
 * @param id – session UUID
 */
export async function ptyInfo(id: string): Promise<SessionInfo> {
  return invoke("pty_info", { id });
}

/**
 * Subscribe to a PTY session's output via a Tauri Channel.
 *
 * @param id      – session UUID returned by `pty_spawn`
 * @param channel – Tauri Channel that receives batched `Vec<u8>` output
 *
 * The channel receives coalesced output flushed every ~16 ms.
 * Can be called again after a frontend reload to re-attach.
 */
export async function ptySubscribe(id: string, channel: Channel<Uint8Array>): Promise<void> {
  return invoke("pty_subscribe", { id, channel });
}

/**
 * Write raw bytes to a PTY session's stdin.
 *
 * @param id   - session UUID returned by `pty_spawn`
 * @param data - raw bytes to forward (e.g. from xterm.js `onData`)
 */
export async function ptyWrite(id: string, data: Uint8Array): Promise<void> {
  return invoke("pty_write", { id, data });
}

/**
 * Resize a PTY session's terminal dimensions.
 *
 * @param id   - session UUID returned by `pty_spawn`
 * @param cols - new terminal width in columns
 * @param rows - new terminal height in rows
 */
export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

/**
 * Kill a PTY session with graceful shutdown.
 *
 * @param id - session UUID returned by `pty_spawn`
 */
export async function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

/**
 * Retrieve scrollback buffer data for a PTY session.
 *
 * @param id     – session UUID returned by `pty_spawn`
 * @param offset – byte offset from the start of the scrollback buffer
 * @param limit  – maximum number of bytes to return
 * @returns array of byte chunks that can be replayed into xterm.js
 *
 * Call this before `ptySubscribe` when a terminal mounts so the user
 * sees historical output immediately.
 */
export async function ptyGetScrollback(
  id: string,
  offset: number,
  limit: number
): Promise<Uint8Array[]> {
  const chunks: number[][] = await invoke("pty_get_scrollback", { id, offset, limit });
  return chunks.map((c) => new Uint8Array(c));
}

/**
 * List all projects ordered by position.
 */
export async function projectList(): Promise<Project[]> {
  return invoke("project_list");
}

/**
 * Create a new project.
 */
export async function projectCreate(input: {
  name: string;
  path: string;
  color?: string | null;
  icon?: string | null;
  env_json?: string | null;
}): Promise<Project> {
  return invoke("project_create", { input });
}

/**
 * Update an existing project.
 */
export async function projectUpdate(
  id: string,
  input: {
    name?: string;
    path?: string;
    color?: string | null;
    icon?: string | null;
    default_cli?: string | null;
    env_json?: string | null;
    position?: number;
  }
): Promise<Project> {
  return invoke("project_update", { id, input });
}

/**
 * Delete a project by ID.
 */
export async function projectDelete(id: string): Promise<void> {
  return invoke("project_delete", { id });
}

/**
 * A detected CLI with its resolved absolute path and version.
 */
export interface DetectedCli {
  name: string;
  path: string;
  version: string | null;
}

/**
 * List CLIs available on the system PATH.
 *
 * Returns `{ name, path, version? }` for each detected CLI.
 * Scans for: `claude`, `kimi`, `codex`, `bash`, `zsh`, `pwsh`.
 */
export async function cliListAvailable(): Promise<DetectedCli[]> {
  return invoke("cli_list_available");
}

/**
 * Open a native folder picker dialog.
 *
 * Returns the absolute path of the selected folder, or `null` if the user cancelled.
 */
export async function pickFolder(): Promise<string | null> {
  return invoke("pick_folder");
}

/**
 * Read plain text from the system clipboard.
 *
 * Uses the Tauri clipboard manager plugin for reliable access
 * inside the WebView (avoids browser permission prompts).
 */
export { clipboardReadText };
