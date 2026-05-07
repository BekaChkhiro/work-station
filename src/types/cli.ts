// Static CLI catalogue used by the Add/Edit project form (T6.5) and the
// per-pane CLI badge (T7.7).
//
// This is the interim list — T7.1 will replace `PROJECT_CLI_OPTIONS` with
// values detected on PATH at boot. The shape is intentionally a strict
// subset of what T7.1 will return so consumers (form, badge, popover) can
// migrate without changing types.
//
// Badge metadata (T7.7) is keyed by the same `id` so the form's selection,
// the spawn `WS_CLI_NAME`, and the badge rendered next to a running pane
// all agree on a single canonical lookup. Colors land on accent hues that
// are visually distinct without clashing with the workspace accent — the
// agentic CLIs get warm/cool oklch hues, shells stay neutral.

import type { CliMeta } from "./tab";

export interface CliOption {
  /** Stable id stored in `projects.default_cli`. */
  id: string;
  /** Human-readable label shown in the form. */
  name: string;
  /** Two-letter badge (T7.7). */
  badge: string;
  /** Short description rendered as helper text. */
  description: string;
  /** Optional accent color used by the CLI badge (T7.7). Omitted entries
   *  fall back to the neutral surface tone — used for plain shells where a
   *  vivid accent would compete with the project swatch. */
  color?: string;
}

export const PROJECT_CLI_OPTIONS: readonly CliOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    badge: "cc",
    description: "Anthropic agentic CLI",
    color: "oklch(0.74 0.11 188)",
  },
  {
    id: "codex",
    name: "codex",
    badge: "cx",
    description: "OpenAI CLI",
    color: "oklch(0.72 0.16 320)",
  },
  {
    id: "kimi",
    name: "Kimi",
    badge: "km",
    description: "Moonshot k2 chat",
    color: "oklch(0.78 0.13 90)",
  },
  {
    id: "zsh",
    name: "zsh",
    badge: "zs",
    description: "Z shell",
  },
  {
    id: "bash",
    name: "bash",
    badge: "ba",
    description: "Bourne again shell",
  },
  {
    id: "pwsh",
    name: "PowerShell",
    badge: "ps",
    description: "Cross-platform PowerShell",
    color: "oklch(0.72 0.13 250)",
  },
] as const;

/** Lookup helper. Returns `null` for unknown ids so the UI can degrade
 *  gracefully if the DB row references a CLI no longer in the catalogue. */
export function findCliOption(id: string | null | undefined): CliOption | null {
  if (!id) return null;
  return PROJECT_CLI_OPTIONS.find((c) => c.id === id) ?? null;
}

/** T7.7 — resolve the CLI badge metadata for a given id. Returns `null`
 *  for ids outside the canonical list so callers can render a fallback
 *  glyph (TabStrip already handles that with `FALLBACK_BADGE`). */
export function cliMetaForId(id: string | null | undefined): CliMeta | null {
  const option = findCliOption(id);
  if (!option) return null;
  return option.color ? { badge: option.badge, color: option.color } : { badge: option.badge };
}

/** T7.7 — full canonical id → badge map. Useful for surfaces that take a
 *  `Record<string, CliMeta>` (e.g. TabStrip's `cliMap` prop) instead of a
 *  per-id resolver. */
export const CLI_BADGE_MAP: Readonly<Record<string, CliMeta>> = Object.freeze(
  Object.fromEntries(
    PROJECT_CLI_OPTIONS.map((opt) => [
      opt.id,
      opt.color ? { badge: opt.badge, color: opt.color } : { badge: opt.badge },
    ]),
  ),
);
