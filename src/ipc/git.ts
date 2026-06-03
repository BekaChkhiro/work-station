// Typed wrappers for the Git working-tree commands backing the Agent view's
// review panel. Local-only (dev/POC) — no-op outside the Tauri runtime.

import { invoke } from "@tauri-apps/api/core";

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface GitFile {
  path: string;
  staged: boolean;
  status: string;
  adds: number;
  dels: number;
}

export interface GitStatus {
  branch: string;
  files: GitFile[];
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  if (!isTauriRuntime()) return { branch: "—", files: [] };
  return invoke<GitStatus>("git_status", { args: { cwd } });
}

export async function gitDiffFile(cwd: string, path: string, staged: boolean): Promise<string> {
  if (!isTauriRuntime()) return "";
  return invoke<string>("git_diff_file", { args: { cwd, path, staged } });
}

export async function gitStage(cwd: string, path: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("git_stage", { args: { cwd, path } });
}

export async function gitUnstage(cwd: string, path: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("git_unstage", { args: { cwd, path } });
}

export async function gitDiscard(cwd: string, path: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("git_discard", { args: { cwd, path } });
}

export async function gitStageAll(cwd: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("git_stage_all", { args: { cwd } });
}

export async function gitCommit(cwd: string, message: string): Promise<string> {
  if (!isTauriRuntime()) return "";
  return invoke<string>("git_commit", { args: { cwd, message } });
}
