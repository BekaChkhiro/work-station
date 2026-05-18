// Start-mode choices surfaced in the PlanFlow tab's "Start working"
// chevron. The user picks how autonomous the agent should be; the
// orchestrator translates the pick into args on the
// `planflow_task_start(...)` prompt that gets typed into the spawned
// CLI. Stored as the literal mode id (see `app_settings.planflow_last_start_mode`)
// so a relaunch lands on whichever flow the user last picked.

export type PlanFlowStartMode = "manual" | "pr" | "merge-master" | "none";

export const PLANFLOW_START_MODE_IDS: readonly PlanFlowStartMode[] = [
  "manual",
  "pr",
  "merge-master",
  "none",
];

export interface PlanFlowStartModeOption {
  id: PlanFlowStartMode;
  label: string;
  /** One-line hint shown under the label in the mode picker menu. */
  hint: string;
  /** When true the option renders with a danger affordance (currently
   *  only merge-master, which pushes to master without review). */
  danger?: boolean;
}

export const PLANFLOW_START_MODES: readonly PlanFlowStartModeOption[] = [
  {
    id: "manual",
    label: "Manual",
    hint: "Load context, no autoExecute — type your own follow-up",
  },
  {
    id: "pr",
    label: "Auto · PR strategy",
    hint: "implement → test → push → open PR → DONE",
  },
  {
    id: "merge-master",
    label: "Auto · Merge to master",
    hint: "implement → test → merge & push master → DONE (no review)",
    danger: true,
  },
  {
    id: "none",
    label: "Auto · Push only",
    hint: "implement → push branch → DONE (no PR / no merge)",
  },
];

export const DEFAULT_PLANFLOW_START_MODE: PlanFlowStartMode = "manual";

export function isPlanFlowStartMode(value: string): value is PlanFlowStartMode {
  return (PLANFLOW_START_MODE_IDS as readonly string[]).includes(value);
}

/** Build the `planflow_task_start(...)` literal the launcher types into
 *  claude. `mode === "manual"` is the bare call; everything else adds
 *  `autoExecute: true, mergeStrategy: "..."` so the agent kicks off
 *  its autonomous loop on submit. */
export function formatPlanFlowStartPromptForMode(taskId: string, mode: PlanFlowStartMode): string {
  const escaped = taskId.replace(/"/g, '\\"');
  if (mode === "manual") {
    return `planflow_task_start(taskId: "${escaped}")`;
  }
  const merge: string = mode === "merge-master" ? "merge-master" : mode;
  return `planflow_task_start(taskId: "${escaped}", autoExecute: true, mergeStrategy: "${merge}")`;
}
