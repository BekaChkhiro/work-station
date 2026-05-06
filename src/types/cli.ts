// Static CLI catalogue used by the Add/Edit project form (T6.5).
//
// This is the interim list — T7.1 will replace `PROJECT_CLI_OPTIONS` with
// values detected on PATH at boot. The shape is intentionally a strict
// subset of what T7.1 will return so consumers (form, badge, popover) can
// migrate without changing types.

export interface CliOption {
  /** Stable id stored in `projects.default_cli`. */
  id: string;
  /** Human-readable label shown in the form. */
  name: string;
  /** Two-letter badge (T7.7). */
  badge: string;
  /** Short description rendered as helper text. */
  description: string;
}

export const PROJECT_CLI_OPTIONS: readonly CliOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    badge: "CC",
    description: "Anthropic agentic CLI",
  },
  {
    id: "codex",
    name: "codex",
    badge: "CX",
    description: "OpenAI CLI",
  },
  {
    id: "kimi",
    name: "Kimi",
    badge: "KI",
    description: "Moonshot k2 chat",
  },
  {
    id: "zsh",
    name: "zsh",
    badge: "ZH",
    description: "Z shell",
  },
  {
    id: "bash",
    name: "bash",
    badge: "BA",
    description: "Bourne again shell",
  },
  {
    id: "pwsh",
    name: "PowerShell",
    badge: "PS",
    description: "Cross-platform PowerShell",
  },
] as const;

/** Lookup helper. Returns `null` for unknown ids so the UI can degrade
 *  gracefully if the DB row references a CLI no longer in the catalogue. */
export function findCliOption(id: string | null | undefined): CliOption | null {
  if (!id) return null;
  return PROJECT_CLI_OPTIONS.find((c) => c.id === id) ?? null;
}
