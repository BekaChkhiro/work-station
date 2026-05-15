// T8.7 — Settings page. A full-window modal opened via Cmd+, the sidebar
// cog, or the File → Settings menu item. Sections mirror the design spec
// (General / Appearance / Keybindings / CLIs / Privacy / About); all writes
// flow through the existing `app_settings` wrapper so rebinds, theme picks,
// font changes, and scrollback adjustments persist across restarts.
//
// The hotkey rebinder uses a transient capture mode: a row enters "press a
// shortcut" state, document keydown is captured (preventDefault to keep the
// shell from getting it), the pending binding renders as chips, and the
// user confirms with Save (Enter) or cancels (Esc). Conflict detection runs
// on the pending binding against every *other* action and blocks saving
// until the shortcut is unique.

import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { JSX } from "solid-js";

import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import QRCode from "qrcode";

import {
  bindingsEqual,
  findConflicts,
  formatBinding,
  getDefaultBinding,
  listActions,
  resetBindingsToDefaults,
  setBinding,
  type Binding,
  type HotkeyAction,
  type Modifier,
} from "../../hotkeys";
import { isMac } from "../../utils/platform";
import { setThemeMode, themeMode, type ThemeMode } from "../../stores/theme";
import {
  densityMode,
  monoFontMode,
  setDensity,
  setMonoFont,
  setUiFontSize,
  uiFontSizeMode,
  type Density,
  type MonoFont,
} from "../../stores/appearance";
import { getSetting, setSetting } from "../../db/settings";
import { cliListAvailable, type CliInfo } from "../../ipc/cli";
import {
  cancelQueuedForReauth,
  clearNeedsReauthAndReplay,
  CredentialsError,
  createPlanFlowClient,
  DEFAULT_ACCOUNT,
  hydrateReauthState,
  Integration,
  IntegrationVerifyError,
  clearIntegrationStatus,
  deleteCredential,
  getCredential,
  getIntegrationStatusMap,
  hasCredential,
  PlanFlowApiError,
  PlanFlowAuthError,
  PLANFLOW_DEFAULT_BASE_URL,
  setCredential,
  setIntegrationStatus,
  verifyIntegration,
  type IntegrationId,
  type IntegrationStatusEntry,
  type Project as PlanFlowProject,
} from "../../integrations";
import {
  activeProjectId,
  activeTab as activeWorkspaceTab,
  projects as workspaceProjects,
  setTabVisibility,
  visibleTabs as visibleWorkspaceTabs,
} from "../../stores/workspace";
import {
  deleteProjectLink,
  listProjectLinks,
  setProjectLink,
  type ProjectLink,
} from "../../db/projectLinks";
import { updateProjectWorkspaceTabs } from "../../db/projects";

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

type SectionId =
  | "general"
  | "appearance"
  | "keys"
  | "clis"
  | "integrations"
  | "mobile"
  | "privacy"
  | "about";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "keys", label: "Keybindings" },
  { id: "clis", label: "CLIs" },
  { id: "integrations", label: "Integrations" },
  { id: "mobile", label: "Mobile pairing" },
  { id: "privacy", label: "Privacy" },
  { id: "about", label: "About" },
];

export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const [section, setSection] = createSignal<SectionId>("general");

  // Esc closes — captured at document level so an open rebinder row
  // (which has its own document keydown) doesn't swallow it. Esc inside
  // a capturing rebinder cancels the capture instead (handled below).
  createEffect(() => {
    if (!props.open) return;
    const onDocKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // The rebinder owns Esc while capturing. Detect via the data flag
      // it stamps on the document body.
      if (document.body.dataset.wsRebindCapture === "1") return;
      e.preventDefault();
      props.onClose();
    };
    document.addEventListener("keydown", onDocKey, { capture: true });
    onCleanup(() => document.removeEventListener("keydown", onDocKey, { capture: true }));
  });

  return (
    <Show when={props.open}>
      <div
        class="ws-settings-page__backdrop"
        onMouseDown={(e) => {
          if (e.currentTarget === e.target) props.onClose();
        }}
      >
        <div
          class="ws-settings-page"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div class="ws-settings-page__head">
            <button
              type="button"
              class="ws-settings-page__back"
              onClick={() => props.onClose()}
              aria-label="Close settings"
            >
              <span aria-hidden="true">←</span>
              <span>Settings</span>
            </button>
            <span class="ws-settings-page__hint">Esc to close</span>
          </div>

          <div class="ws-settings-page__body">
            <nav class="ws-settings-page__rail" aria-label="Settings sections">
              <For each={SECTIONS}>
                {(s) => (
                  <button
                    type="button"
                    class="ws-settings-page__nav"
                    data-active={section() === s.id ? "true" : undefined}
                    onClick={() => setSection(s.id)}
                  >
                    {s.label}
                  </button>
                )}
              </For>
            </nav>

            <div class="ws-settings-page__content">
              <div class="ws-settings-page__inner">
                <Switch>
                  <Match when={section() === "general"}>
                    <GeneralSection />
                  </Match>
                  <Match when={section() === "appearance"}>
                    <AppearanceSection />
                  </Match>
                  <Match when={section() === "keys"}>
                    <KeysSection />
                  </Match>
                  <Match when={section() === "clis"}>
                    <CliSection />
                  </Match>
                  <Match when={section() === "integrations"}>
                    <IntegrationsSection />
                  </Match>
                  <Match when={section() === "mobile"}>
                    <MobileSection />
                  </Match>
                  <Match when={section() === "privacy"}>
                    <PrivacySection />
                  </Match>
                  <Match when={section() === "about"}>
                    <AboutSection />
                  </Match>
                </Switch>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

export default SettingsPanel;

/* ─── General ───────────────────────────────────────────────────────── */

function GeneralSection(): JSX.Element {
  const [fallback, setFallback] = createSignal<string>("");
  const [scrollback, setScrollback] = createSignal<number>(10_000);

  // Hydrate from SQL on mount. We render the defaults until the first read
  // resolves — the panel doesn't gate input, so a fast user interaction
  // before hydrate is fine (it just overwrites the stale default).
  createEffect(() => {
    void Promise.all([getSetting("default_fallback_cli"), getSetting("scrollback_size")]).then(
      ([cli, sb]) => {
        batch(() => {
          setFallback(cli ?? "");
          setScrollback(sb);
        });
      },
    );
  });

  const commitFallback = (raw: string): void => {
    const trimmed = raw.trim();
    void setSetting("default_fallback_cli", trimmed === "" ? null : trimmed);
  };
  const commitScrollback = (n: number): void => {
    if (!Number.isFinite(n) || n <= 0) return;
    void setSetting("scrollback_size", Math.round(n));
  };

  return (
    <>
      <h2 class="ws-settings-page__section-title">General</h2>
      <div class="ws-settings-page__group">
        <div class="ws-settings-page__row">
          <div>
            <div class="ws-settings-page__lbl">
              Send anonymous performance metrics <span class="ws-settings-page__badge">v0.2</span>
            </div>
            <div class="ws-settings-page__hint">
              Helps us optimize cold start and memory usage. No command or output content is ever
              sent.
            </div>
          </div>
          <Toggle on={false} disabled />
        </div>

        <div class="ws-settings-page__row">
          <div>
            <div class="ws-settings-page__lbl">
              Open at login <span class="ws-settings-page__badge">v0.2</span>
            </div>
            <div class="ws-settings-page__hint">
              Start Work Station automatically when you sign in.
            </div>
          </div>
          <Toggle on={false} disabled />
        </div>
      </div>

      <div class="ws-settings-page__group">
        <div class="ws-settings-page__row col">
          <div>
            <div class="ws-settings-page__lbl">Default fallback CLI</div>
            <div class="ws-settings-page__hint">
              Used when a project's preferred CLI isn't installed. Leave empty to keep the built-in
              platform default (zsh on macOS, PowerShell on Windows).
            </div>
          </div>
          <input
            type="text"
            class="ws-settings-page__input"
            placeholder="zsh"
            value={fallback()}
            onInput={(e) => setFallback(e.currentTarget.value)}
            onBlur={(e) => commitFallback(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            }}
          />
        </div>

        <div class="ws-settings-page__row col">
          <div>
            <div class="ws-settings-page__lbl">Scrollback per session</div>
            <div class="ws-settings-page__hint">
              Lines retained in each pane's scrollback ring. Larger means more history at the cost
              of memory. ({scrollback().toLocaleString()} lines)
            </div>
          </div>
          <div class="ws-settings-page__slider-row">
            <input
              type="range"
              class="ws-settings-page__slider"
              min={1_000}
              max={100_000}
              step={1_000}
              value={scrollback()}
              onInput={(e) => setScrollback(Number(e.currentTarget.value))}
              onChange={(e) => commitScrollback(Number(e.currentTarget.value))}
            />
            <span class="ws-settings-page__slider-val">{Math.round(scrollback() / 1000)}k</span>
          </div>
        </div>
      </div>
    </>
  );
}

/* ─── Appearance ────────────────────────────────────────────────────── */

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

const DENSITIES: { id: Density; label: string }[] = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
];

const MONO_FONTS: { id: MonoFont; label: string }[] = [
  { id: "jetbrains", label: "JetBrains Mono" },
  { id: "geist", label: "Geist Mono" },
  { id: "berkeley", label: "Berkeley Mono" },
  { id: "system", label: "System" },
];

function AppearanceSection(): JSX.Element {
  return (
    <>
      <h2 class="ws-settings-page__section-title">Appearance</h2>

      <div class="ws-settings-page__group">
        <div class="ws-settings-page__row">
          <div>
            <div class="ws-settings-page__lbl">Theme</div>
            <div class="ws-settings-page__hint">System follows your OS appearance setting.</div>
          </div>
          <Segmented options={THEMES} value={themeMode()} onChange={(v) => setThemeMode(v)} />
        </div>

        <div class="ws-settings-page__row">
          <div>
            <div class="ws-settings-page__lbl">Density</div>
            <div class="ws-settings-page__hint">
              Compact tightens row heights and tab strip spacing.
            </div>
          </div>
          <Segmented options={DENSITIES} value={densityMode()} onChange={(v) => setDensity(v)} />
        </div>
      </div>

      <div class="ws-settings-page__group">
        <div class="ws-settings-page__row col">
          <div>
            <div class="ws-settings-page__lbl">Terminal font</div>
            <div class="ws-settings-page__hint">
              Used for terminal output and inline code chips. Falls back to the system mono when the
              chosen face isn't installed.
            </div>
          </div>
          <Segmented options={MONO_FONTS} value={monoFontMode()} onChange={(v) => setMonoFont(v)} />
        </div>

        <div class="ws-settings-page__row col">
          <div>
            <div class="ws-settings-page__lbl">UI font size</div>
            <div class="ws-settings-page__hint">
              Base size for sidebar labels, tabs, and dialogs ({uiFontSizeMode()}px).
            </div>
          </div>
          <div class="ws-settings-page__slider-row">
            <input
              type="range"
              class="ws-settings-page__slider"
              min={12}
              max={16}
              step={1}
              value={uiFontSizeMode()}
              onInput={(e) => setUiFontSize(Number(e.currentTarget.value))}
            />
            <span class="ws-settings-page__slider-val">{uiFontSizeMode()}px</span>
          </div>
        </div>
      </div>
    </>
  );
}

/* ─── Keybindings ───────────────────────────────────────────────────── */

interface PendingRebind {
  actionId: string;
  binding: Binding | null;
}

function KeysSection(): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [pending, setPending] = createSignal<PendingRebind | null>(null);
  const [resetting, setResetting] = createSignal(false);

  onCleanup(() => {
    delete document.body.dataset.wsRebindCapture;
  });

  const actions = createMemo<readonly HotkeyAction[]>(() => listActions());
  const filtered = createMemo<readonly HotkeyAction[]>(() => {
    const q = query().trim().toLowerCase();
    const all = actions();
    if (!q) return all;
    return all.filter((a) => {
      if (a.label.toLowerCase().includes(q)) return true;
      if (a.id.toLowerCase().includes(q)) return true;
      if (formatBinding(a.binding).toLowerCase().includes(q)) return true;
      return false;
    });
  });

  // Find which existing action(s) clash with the pending binding (other
  // than the action being edited). Powers the inline conflict warning.
  const pendingConflict = createMemo<HotkeyAction | null>(() => {
    const p = pending();
    if (!p || !p.binding) return null;
    const binding = p.binding;
    const other = actions().find((a) => a.id !== p.actionId && bindingsEqual(a.binding, binding));
    return other ?? null;
  });

  const startEdit = (id: string): void => {
    setPending({ actionId: id, binding: null });
    document.body.dataset.wsRebindCapture = "1";
  };

  const cancelEdit = (): void => {
    setPending(null);
    delete document.body.dataset.wsRebindCapture;
  };

  const save = (id: string, b: Binding): void => {
    setBinding(id, b);
    cancelEdit();
  };

  // Capture-mode keydown — translate KeyboardEvent into a Binding. Modifier-
  // only presses (e.g. user holding Cmd alone) don't commit; we wait for a
  // non-modifier key. Esc cancels; Enter saves the current pending binding.
  createEffect(() => {
    const p = pending();
    if (!p) return;
    const handler = (e: KeyboardEvent): void => {
      // Save/cancel commands first.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelEdit();
        return;
      }
      if (e.key === "Enter" && p.binding) {
        e.preventDefault();
        e.stopPropagation();
        if (!pendingConflict()) save(p.actionId, p.binding);
        return;
      }
      // Ignore plain modifier presses; they only register together with a key.
      if (
        e.key === "Shift" ||
        e.key === "Alt" ||
        e.key === "Meta" ||
        e.key === "Control" ||
        e.key === "OS" ||
        e.key === "AltGraph"
      ) {
        e.preventDefault();
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const mods: Modifier[] = [];
      const hasMod = isMac ? e.metaKey : e.ctrlKey;
      if (hasMod) mods.push("mod");
      if (e.shiftKey) mods.push("shift");
      if (e.altKey) mods.push("alt");
      setPending({ actionId: p.actionId, binding: { modifiers: mods, key: e.key } });
    };
    document.addEventListener("keydown", handler, { capture: true });
    onCleanup(() => {
      document.removeEventListener("keydown", handler, { capture: true });
    });
  });

  const reset = async (): Promise<void> => {
    if (resetting()) return;
    setResetting(true);
    try {
      await resetBindingsToDefaults();
    } finally {
      setResetting(false);
    }
  };

  const labelLookup = (id: string): string => actions().find((a) => a.id === id)?.label ?? id;

  return (
    <>
      <h2 class="ws-settings-page__section-title">Keybindings</h2>
      <div class="ws-settings-page__group">
        <div class="ws-settings-page__row col">
          <input
            type="text"
            class="ws-settings-page__input"
            placeholder="Filter actions or bindings…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            spellcheck={false}
            autocomplete="off"
            aria-label="Filter keybindings"
          />
        </div>

        <Show when={findConflicts().length > 0}>
          <div class="ws-settings-page__warn" role="alert">
            <For each={findConflicts()}>
              {(c) => (
                <div>
                  <span aria-hidden="true">⚠ </span>
                  <kbd class="ws-cheat__chip">{formatBinding(c.binding)}</kbd> is bound to{" "}
                  {c.ids.map((id) => labelLookup(id)).join(" and ")}
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="ws-settings-page__hk-table" role="list">
          <For each={filtered()}>
            {(a) => {
              const overridden = (): boolean => {
                const def = getDefaultBinding(a.id);
                return !!def && !bindingsEqual(def, a.binding);
              };
              const isEditing = (): boolean => pending()?.actionId === a.id;
              return (
                <div class="ws-settings-page__hk-row" role="listitem">
                  <div>
                    <div class="ws-settings-page__hk-label">{a.label}</div>
                    <Show when={overridden() && !isEditing()}>
                      <div class="ws-settings-page__hk-sub">customized</div>
                    </Show>
                  </div>
                  <div class="ws-settings-page__hk-keys">
                    <Show
                      when={isEditing()}
                      fallback={<kbd class="ws-cheat__chip">{formatBinding(a.binding)}</kbd>}
                    >
                      <span class="ws-settings-page__hk-capture">
                        <Show when={pending()?.binding} fallback={<em>Press a shortcut…</em>}>
                          {(binding) => (
                            <kbd class="ws-cheat__chip">{formatBinding(binding())}</kbd>
                          )}
                        </Show>
                        <Show when={pendingConflict()}>
                          {(conflict) => (
                            <span class="ws-settings-page__hk-warn">
                              ⚠ used by "{conflict().label}"
                            </span>
                          )}
                        </Show>
                      </span>
                    </Show>
                  </div>
                  <div class="ws-settings-page__hk-actions">
                    <Show
                      when={isEditing()}
                      fallback={
                        <button
                          type="button"
                          class="ws-settings-page__btn"
                          onClick={() => startEdit(a.id)}
                        >
                          Edit
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="ws-settings-page__btn"
                        disabled={!pending()?.binding || !!pendingConflict()}
                        onClick={() => {
                          const b = pending()?.binding;
                          if (b && !pendingConflict()) save(a.id, b);
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        class="ws-settings-page__btn ws-settings-page__btn--ghost"
                        onClick={() => cancelEdit()}
                      >
                        Cancel
                      </button>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
          <Show when={filtered().length === 0}>
            <div class="ws-settings-page__empty">No actions match.</div>
          </Show>
        </div>

        <div class="ws-settings-page__row">
          <div class="ws-settings-page__hint">
            Rebinds take effect immediately — no restart required.
          </div>
          <button
            type="button"
            class="ws-settings-page__btn ws-settings-page__btn--ghost"
            disabled={resetting()}
            onClick={() => void reset()}
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </>
  );
}

/* ─── CLIs ──────────────────────────────────────────────────────────── */

function CliSection(): JSX.Element {
  const [clis, setClis] = createSignal<readonly CliInfo[]>([]);
  const [loading, setLoading] = createSignal(false);

  const refresh = async (): Promise<void> => {
    if (loading()) return;
    setLoading(true);
    try {
      const list = await cliListAvailable();
      setClis(list);
    } catch (err) {
      console.warn("[settings] cli list refresh failed", err);
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    void refresh();
  });

  return (
    <>
      <h2 class="ws-settings-page__section-title">CLIs</h2>
      <div class="ws-settings-page__group">
        <div class="ws-settings-page__row">
          <div>
            <div class="ws-settings-page__lbl">Detected CLIs</div>
            <div class="ws-settings-page__hint">
              Discovered on your PATH at startup. Each project picks one as its default.
            </div>
          </div>
          <button
            type="button"
            class="ws-settings-page__btn ws-settings-page__btn--ghost"
            disabled={loading()}
            onClick={() => void refresh()}
          >
            {loading() ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <Show
          when={clis().length > 0}
          fallback={
            <div class="ws-settings-page__empty">
              No CLIs detected yet. Click Refresh after installing one.
            </div>
          }
        >
          <div class="ws-settings-page__cli-list" role="list">
            <For each={clis()}>
              {(cli) => (
                <div class="ws-settings-page__cli-row" role="listitem">
                  <span class="ws-settings-page__cli-name">{cli.name}</span>
                  <span class="ws-settings-page__cli-version">{cli.version ?? "—"}</span>
                  <span class="ws-settings-page__cli-path">{cli.path}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="ws-settings-page__row">
          <div>
            <div class="ws-settings-page__lbl">
              Add custom CLI <span class="ws-settings-page__badge">v0.2</span>
            </div>
            <div class="ws-settings-page__hint">
              Register a CLI that isn't on PATH by giving it a name and absolute path.
            </div>
          </div>
          <button type="button" class="ws-settings-page__btn" disabled>
            Add…
          </button>
        </div>
      </div>
    </>
  );
}

/* ─── Integrations (T11.3) ──────────────────────────────────────────── */

interface IntegrationDef {
  id: IntegrationId;
  label: string;
  description: string;
  endpoint: string;
  /** T12.2 — external URL where the user can mint a fresh API token. The
   *  card renders it as a "Get token" anchor next to the description. */
  getTokenUrl: string;
}

// T11.6 — every integration now ships a minimal authenticated GET (or the
// equivalent GraphQL query for Railway). The dispatcher in
// `integrations/verifiers` owns the per-service request shape; the panel only
// passes the token through.
const INTEGRATIONS: readonly IntegrationDef[] = [
  {
    id: Integration.PlanFlow,
    label: "PlanFlow",
    description: "Tasks, knowledge, and activity sync for this project.",
    endpoint: PLANFLOW_DEFAULT_BASE_URL,
    getTokenUrl: "https://planflow.tools/settings/api-tokens",
  },
  {
    id: Integration.GitHub,
    label: "GitHub",
    description: "Repository overview, pull requests, and workflow runs.",
    endpoint: "api.github.com",
    getTokenUrl: "https://github.com/settings/tokens",
  },
  {
    id: Integration.Vercel,
    label: "Vercel",
    description: "Deployments, build logs, and environment variables.",
    endpoint: "api.vercel.com",
    getTokenUrl: "https://vercel.com/account/tokens",
  },
  {
    id: Integration.Neon,
    label: "Neon",
    description: "Branches, connection strings, and SQL queries.",
    endpoint: "console.neon.tech",
    getTokenUrl: "https://console.neon.tech/app/settings/api-keys",
  },
  {
    id: Integration.Railway,
    label: "Railway",
    description: "Services, deployments, and live log streams.",
    endpoint: "backboard.railway.app",
    getTokenUrl: "https://railway.com/account/tokens",
  },
];

type Phase =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "verifying" }
  | { kind: "error"; message: string };

interface RowState {
  hasToken: boolean;
  status: IntegrationStatusEntry | null;
  draft: string;
  reveal: boolean;
  phase: Phase;
}

function IntegrationsSection(): JSX.Element {
  const [rows, setRows] = createSignal<Record<string, RowState>>({});
  // T11.10 — first-run reassurance card. Starts hidden until the stored
  // flag resolves so we never render-then-yank it on dismissed users.
  const [introState, setIntroState] = createSignal<"loading" | "shown" | "dismissed">("loading");

  const emptyRow = (): RowState => ({
    hasToken: false,
    status: null,
    draft: "",
    reveal: false,
    phase: { kind: "idle" },
  });

  const patch = (id: string, updates: Partial<RowState>): void => {
    setRows((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? emptyRow()), ...updates },
    }));
  };

  const hydrate = async (): Promise<void> => {
    const statusMap = await getIntegrationStatusMap();
    const entries = await Promise.all(
      INTEGRATIONS.map(async (def) => {
        let hasToken = false;
        try {
          hasToken = await hasCredential(def.id, DEFAULT_ACCOUNT);
        } catch (err) {
          console.warn("[integrations] hasCredential failed", def.id, err);
        }
        const row: RowState = {
          hasToken,
          status: statusMap[def.id] ?? null,
          draft: "",
          reveal: false,
          phase: { kind: "idle" },
        };
        return [def.id, row] as const;
      }),
    );
    setRows(Object.fromEntries(entries));
  };

  onMount(() => {
    void hydrate();
    // The shell hydrates the reauth state once on launch; calling it
    // again here is cheap (idempotent) and guarantees the panel is
    // never the first reader.
    void hydrateReauthState();
    void getSetting("integrations_intro_dismissed").then((dismissed) => {
      setIntroState(dismissed ? "dismissed" : "shown");
    });
  });

  const dismissIntro = (): void => {
    setIntroState("dismissed");
    // Best-effort write — a transient SQLite failure shouldn't keep the
    // card on screen, the in-memory flag is the source of truth for this
    // session and the next mount will re-read the row.
    void setSetting("integrations_intro_dismissed", true).catch((err: unknown) => {
      console.warn("[T11.10] failed to persist integrations intro dismissal", err);
    });
  };

  const save = async (def: IntegrationDef): Promise<void> => {
    const row = rows()[def.id];
    const token = row?.draft.trim() ?? "";
    if (!token) return;
    patch(def.id, { phase: { kind: "saving" } });
    try {
      await setCredential(def.id, DEFAULT_ACCOUNT, token);
      // Saving a new token invalidates any cached "Connected as …" — the
      // user must re-verify to prove the fresh token works.
      await clearIntegrationStatus(def.id);
      patch(def.id, {
        hasToken: true,
        status: null,
        draft: "",
        reveal: false,
        phase: { kind: "idle" },
      });
    } catch (err) {
      patch(def.id, { phase: { kind: "error", message: describeError(err) } });
    }
  };

  const disconnect = async (def: IntegrationDef): Promise<void> => {
    patch(def.id, { phase: { kind: "saving" } });
    try {
      await deleteCredential(def.id, DEFAULT_ACCOUNT);
      await clearIntegrationStatus(def.id);
      // T11.8 — any requests parked while waiting for re-auth should
      // reject now rather than retry against a now-deleted credential.
      cancelQueuedForReauth(def.id);
      patch(def.id, {
        hasToken: false,
        status: null,
        draft: "",
        reveal: false,
        phase: { kind: "idle" },
      });
    } catch (err) {
      patch(def.id, { phase: { kind: "error", message: describeError(err) } });
    }
  };

  const verify = async (def: IntegrationDef): Promise<void> => {
    patch(def.id, { phase: { kind: "verifying" } });
    try {
      const token = await getCredential(def.id, DEFAULT_ACCOUNT);
      if (!token) {
        patch(def.id, {
          phase: { kind: "error", message: "No token saved. Paste one and Save first." },
        });
        return;
      }
      const result = await verifyIntegration(def.id, token);
      const entry: IntegrationStatusEntry = {
        verifiedAt: Date.now(),
        accountLabel: result.accountLabel,
        accountName: result.accountName ?? null,
        accountEmail: result.accountEmail ?? null,
      };
      await setIntegrationStatus(def.id, entry);
      // T11.8 — verify success dismisses the Reconnect banner and
      // releases any requests that were parked while we waited for
      // a fresh token.
      await clearNeedsReauthAndReplay(def.id);
      patch(def.id, { status: entry, phase: { kind: "idle" } });
    } catch (err) {
      patch(def.id, { phase: { kind: "error", message: describeError(err) } });
    }
  };

  return (
    <>
      <h2 class="ws-settings-page__section-title">Integrations</h2>
      <div class="ws-settings-page__group ws-settings-page__integrations">
        <Show when={introState() === "shown"}>
          <div class="ws-integration-intro" role="note" aria-label="Integrations privacy note">
            <div class="ws-integration-intro__body">
              <div class="ws-integration-intro__title">Your tokens stay on this device</div>
              <div class="ws-integration-intro__text">
                Work Station saves API tokens in your OS keychain — no servers, no middleman. Each
                card below links straight to the right tokens page for the service. Paste a token,
                Verify, and you're connected.
              </div>
            </div>
            <button
              type="button"
              class="ws-integration-intro__dismiss"
              onClick={dismissIntro}
              aria-label="Dismiss intro"
            >
              Got it
            </button>
          </div>
        </Show>
        <For each={INTEGRATIONS}>
          {(def) => {
            const row = (): RowState => rows()[def.id] ?? emptyRow();
            const phase = (): Phase => row().phase;
            const busy = (): boolean => phase().kind === "saving" || phase().kind === "verifying";
            const canSave = (): boolean => row().draft.trim().length > 0 && !busy();
            const canVerify = (): boolean => row().hasToken && !busy();
            // T11.8 — once a long-running call has flagged this
            // integration as needs-reauth the row pivots into
            // "Re-enter token" framing until the next successful Verify
            // clears the flag.
            const needsReauth = (): boolean => row().status?.needsReauthAt != null;
            return (
              <div
                class="ws-integration"
                role="group"
                aria-label={`${def.label} integration`}
                data-needs-reauth={needsReauth() ? "true" : undefined}
              >
                <div class="ws-integration__head">
                  <div class="ws-integration__title">
                    <div class="ws-settings-page__lbl">{def.label}</div>
                    <div class="ws-settings-page__hint">
                      {def.description} · {def.endpoint}
                    </div>
                    <div class="ws-integration__links">
                      <a
                        href={def.getTokenUrl}
                        class="ws-integration__link"
                        onClick={(e) => {
                          e.preventDefault();
                          void openUrl(def.getTokenUrl).catch((err: unknown) => {
                            console.warn("[integrations] openUrl failed", def.id, err);
                          });
                        }}
                        rel="noreferrer noopener"
                        target="_blank"
                      >
                        Get token ↗
                      </a>
                    </div>
                  </div>
                  <IntegrationStatusPill row={row()} />
                </div>

                <Show when={needsReauth()}>
                  <div class="ws-integration__notice" role="status">
                    <span aria-hidden="true">⚠</span> Token rejected by {def.label}. Paste a fresh
                    token and Verify to dismiss this banner.
                  </div>
                </Show>

                <div class="ws-integration__token">
                  <input
                    type={row().reveal ? "text" : "password"}
                    class="ws-settings-page__input ws-integration__input"
                    placeholder={
                      needsReauth()
                        ? "Paste a fresh token to reconnect…"
                        : row().hasToken
                          ? "Paste a new token to replace…"
                          : "Paste API token"
                    }
                    value={row().draft}
                    onInput={(e) => patch(def.id, { draft: e.currentTarget.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canSave()) {
                        e.preventDefault();
                        void save(def);
                      }
                    }}
                    spellcheck={false}
                    autocomplete="off"
                    aria-label={`${def.label} API token`}
                  />
                  <button
                    type="button"
                    class="ws-settings-page__btn ws-settings-page__btn--ghost"
                    onClick={() => patch(def.id, { reveal: !row().reveal })}
                    disabled={row().draft.length === 0}
                    aria-pressed={row().reveal}
                  >
                    {row().reveal ? "Hide" : "Show"}
                  </button>
                  <button
                    type="button"
                    class="ws-settings-page__btn"
                    disabled={!canSave()}
                    onClick={() => void save(def)}
                  >
                    {phase().kind === "saving" ? "Saving…" : "Save"}
                  </button>
                </div>

                <div class="ws-integration__actions">
                  <button
                    type="button"
                    class="ws-settings-page__btn"
                    disabled={!canVerify()}
                    onClick={() => void verify(def)}
                  >
                    {phase().kind === "verifying" ? "Verifying…" : "Verify connection"}
                  </button>
                  <button
                    type="button"
                    class="ws-settings-page__btn ws-settings-page__btn--ghost"
                    disabled={!row().hasToken || busy()}
                    onClick={() => void disconnect(def)}
                  >
                    Disconnect
                  </button>
                </div>

                <Show when={phase().kind === "error" ? phase() : null}>
                  {(p) => (
                    <div class="ws-integration__error" role="alert">
                      <span aria-hidden="true">⚠</span>{" "}
                      {(p() as Extract<Phase, { kind: "error" }>).message}
                    </div>
                  )}
                </Show>

                <Show when={def.id === Integration.PlanFlow && row().status && !needsReauth()}>
                  <PlanFlowLinkPicker />
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </>
  );
}

function IntegrationStatusPill(props: { row: RowState }): JSX.Element {
  const verifying = (): boolean => props.row.phase.kind === "verifying";
  const needsReauth = (): boolean => props.row.status?.needsReauthAt != null;
  const label = (): string => {
    if (verifying()) return "Checking…";
    if (needsReauth()) return "Reconnect required";
    const status = props.row.status;
    if (status) {
      // T12.2 — when the verifier resolved both name and email, prefer the
      // richer "Name (email)" form so the user can confirm both at a glance.
      const name = status.accountName?.trim();
      const email = status.accountEmail?.trim();
      if (name && email) return `Connected · ${name} (${email})`;
      return `Connected · ${status.accountLabel}`;
    }
    if (props.row.hasToken) return "Saved · not verified";
    return "Not connected";
  };
  const tone = (): string => {
    if (verifying()) return "checking";
    if (needsReauth()) return "reauth";
    if (props.row.status) return "ok";
    if (props.row.hasToken) return "saved";
    return "off";
  };
  return (
    <span class="ws-integration__pill" data-tone={tone()}>
      <span class="ws-integration__dot" aria-hidden="true" />
      {label()}
    </span>
  );
}

function describeError(err: unknown): string {
  if (err instanceof IntegrationVerifyError) return err.userMessage;
  if (err instanceof CredentialsError) return err.userMessage;
  if (err instanceof Error) return err.message;
  return "Unexpected error.";
}

/* ─── PlanFlow per-project link picker (T12.2) ──────────────────────── */
//
// Lives inside the PlanFlow card body, scoped to the *currently-active*
// Work Station project. The picker resolves three states:
//
//  1. No active project — Settings was opened without a workspace. Show
//     a hint pointing the user back to the sidebar.
//  2. Active project but no link — load `client.listProjects()` (cached
//     by the underlying HTTP layer) into a `<select>` and let the user
//     pick + Link.
//  3. Active project with an existing link — show the linked project name
//     and an Unlink action. Picking from the dropdown re-links.
//
// Linking persists the row via T11.5's `setProjectLink` *and* flips the
// PlanFlow workspace tab visible (in-memory store + SQLite). Unlinking
// reverses both. The tab strip in AppShell renders the result the next
// time the user closes Settings.

const PLANFLOW_PROJECTS_TTL_MS = 5 * 60 * 1000;

type LinkPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "linking" }
  | { kind: "unlinking" }
  | { kind: "error"; message: string };

function PlanFlowLinkPicker(): JSX.Element {
  const [phase, setPhase] = createSignal<LinkPhase>({ kind: "idle" });
  const [planflowProjects, setPlanflowProjects] = createSignal<PlanFlowProject[]>([]);
  const [link, setLink] = createSignal<ProjectLink | null>(null);
  const [draftId, setDraftId] = createSignal<string>("");

  // The active Work Station project is read each render so opening Settings
  // from inside any project workspace lands on the right scope without an
  // explicit prop drill.
  const wsProjectId = (): string | null => activeProjectId();
  const wsProject = (): { id: string; name: string } | null => {
    const id = wsProjectId();
    if (!id) return null;
    const meta = workspaceProjects().find((p) => p.id === id);
    return meta ? { id: meta.id, name: meta.name } : { id, name: id };
  };

  const refreshLink = async (projectId: string): Promise<void> => {
    try {
      const rows = await listProjectLinks(projectId);
      const existing = rows.find((r) => r.service === Integration.PlanFlow) ?? null;
      setLink(existing);
      setDraftId(existing?.externalId ?? "");
    } catch (err) {
      console.warn("[T12.2] listProjectLinks failed", err);
    }
  };

  const loadProjects = async (): Promise<void> => {
    setPhase({ kind: "loading" });
    try {
      const token = await getCredential(Integration.PlanFlow, DEFAULT_ACCOUNT);
      if (!token) {
        setPhase({
          kind: "error",
          message: "No PlanFlow token saved. Save and verify a token above first.",
        });
        return;
      }
      const client = createPlanFlowClient({
        getAuthToken: () => token,
        // Verify clients deliberately skip the reauth guard so a transient
        // 401 doesn't poison the whole integration; here we *want* the guard
        // because the user is actively working with PlanFlow data and a bad
        // token deserves the Reconnect banner.
        reauthIntegration: Integration.PlanFlow,
      });
      // PlanFlow returns projects scoped to a specific organization. We pass
      // `undefined` so the client resolves the user's default org (matches
      // what the MCP CLI does) and the picker shows every project the user
      // can see.
      const list = await client.listProjects(undefined, PLANFLOW_PROJECTS_TTL_MS);
      // Stable alpha-sort so the dropdown order doesn't shift between fetches.
      const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
      setPlanflowProjects(sorted);
      setPhase({ kind: "idle" });
    } catch (err) {
      setPhase({ kind: "error", message: describePlanFlowError(err) });
    }
  };

  onMount(() => {
    const id = wsProjectId();
    if (id) void refreshLink(id);
    void loadProjects();
  });

  // Switching the active project while Settings is open should re-target
  // the picker without forcing a remount. The effect re-runs on every
  // activeProjectId change.
  createEffect(() => {
    const id = wsProjectId();
    if (!id) {
      setLink(null);
      setDraftId("");
      return;
    }
    void refreshLink(id);
  });

  const linkedProject = createMemo<PlanFlowProject | null>(() => {
    const current = link();
    if (!current) return null;
    return planflowProjects().find((p) => p.id === current.externalId) ?? null;
  });

  // T-feature — auto-suggest a PlanFlow project whose name matches the
  // active workspace project. Only kicks in when the user hasn't already
  // picked a link AND the dropdown is empty — saves a click on first
  // open, doesn't disturb an existing link. Match is case-insensitive
  // and tolerates "Work Station" ↔ "work-station" / "workstation"-style
  // formatting differences.
  const normaliseName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const suggestedId = createMemo<string | null>(() => {
    if (link() != null) return null;
    if (draftId().length > 0) return null;
    const ws = wsProject();
    if (!ws) return null;
    const target = normaliseName(ws.name);
    if (target.length === 0) return null;
    const match = planflowProjects().find((p) => normaliseName(p.name) === target);
    return match?.id ?? null;
  });
  createEffect(() => {
    const sid = suggestedId();
    if (sid == null) return;
    if (draftId().length > 0) return;
    setDraftId(sid);
  });

  const doLink = async (): Promise<void> => {
    const wsId = wsProjectId();
    const target = draftId();
    if (!wsId || !target) return;
    const chosen = planflowProjects().find((p) => p.id === target);
    if (!chosen) return;
    setPhase({ kind: "linking" });
    try {
      const row = await setProjectLink({
        projectId: wsId,
        service: Integration.PlanFlow,
        externalId: chosen.id,
        metadata: { name: chosen.name },
      });
      setLink(row);
      setDraftId(row.externalId);
      // T11.1 — flip the PlanFlow tab visible so the workspace tab strip
      // shows it the next time the user closes Settings. Persist in the
      // same call so a crash before the AppRoot debounce window still
      // sees the new state on relaunch.
      setTabVisibility(wsId, "planflow", true);
      await persistTabsForProject(wsId);
      setPhase({ kind: "idle" });
    } catch (err) {
      setPhase({ kind: "error", message: describeError(err) });
    }
  };

  const doUnlink = async (): Promise<void> => {
    const wsId = wsProjectId();
    const existing = link();
    if (!wsId || !existing) return;
    setPhase({ kind: "unlinking" });
    try {
      await deleteProjectLink(wsId, Integration.PlanFlow, existing.externalId);
      setLink(null);
      setDraftId("");
      setTabVisibility(wsId, "planflow", false);
      await persistTabsForProject(wsId);
      setPhase({ kind: "idle" });
    } catch (err) {
      setPhase({ kind: "error", message: describeError(err) });
    }
  };

  const busy = (): boolean => {
    const p = phase().kind;
    return p === "loading" || p === "linking" || p === "unlinking";
  };

  const canLink = (): boolean => {
    if (busy()) return false;
    const target = draftId();
    if (!target) return false;
    const existing = link();
    if (existing && existing.externalId === target) return false;
    return true;
  };

  return (
    <div class="ws-integration__link-block" role="group" aria-label="PlanFlow project link">
      <div class="ws-integration__link-head">
        <div class="ws-settings-page__lbl">Linked PlanFlow project</div>
        <Show when={wsProject()}>
          {(meta) => (
            <div class="ws-settings-page__hint">
              For Work Station project <strong>{meta().name}</strong>. The PlanFlow tab activates
              once linked.
            </div>
          )}
        </Show>
      </div>

      <Show
        when={wsProject()}
        fallback={
          <div class="ws-settings-page__empty">
            Open a project in the sidebar to link it to a PlanFlow project.
          </div>
        }
      >
        <div class="ws-integration__link-row">
          <select
            class="ws-settings-page__input ws-integration__link-select"
            value={draftId()}
            disabled={busy() || planflowProjects().length === 0}
            onChange={(e) => setDraftId(e.currentTarget.value)}
            aria-label="PlanFlow project"
          >
            <option value="">
              {phase().kind === "loading"
                ? "Loading PlanFlow projects…"
                : planflowProjects().length === 0
                  ? "No PlanFlow projects available"
                  : "Pick a PlanFlow project…"}
            </option>
            <For each={planflowProjects()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
          </select>
          <Show when={suggestedId() != null && link() == null && draftId() === suggestedId()}>
            <div
              class="ws-settings-page__hint ws-settings-page__hint--accent"
              role="status"
              aria-live="polite"
            >
              Suggested match based on project name — click <strong>Link</strong> to confirm.
            </div>
          </Show>
          <button
            type="button"
            class="ws-settings-page__btn"
            disabled={!canLink()}
            onClick={() => void doLink()}
          >
            {phase().kind === "linking" ? "Linking…" : link() ? "Re-link" : "Link"}
          </button>
          <button
            type="button"
            class="ws-settings-page__btn ws-settings-page__btn--ghost"
            disabled={!link() || busy()}
            onClick={() => void doUnlink()}
          >
            {phase().kind === "unlinking" ? "Unlinking…" : "Unlink"}
          </button>
        </div>

        <Show when={link()}>
          {(current) => (
            <div class="ws-integration__link-current" role="status">
              <span aria-hidden="true">✓</span> Linked to{" "}
              <strong>
                {linkedProject()?.name ??
                  (current().metadata?.name as string | undefined) ??
                  current().externalId}
              </strong>
              .
            </div>
          )}
        </Show>

        <Show when={phase().kind === "error" ? phase() : null}>
          {(p) => (
            <div class="ws-integration__error" role="alert">
              <span aria-hidden="true">⚠</span>{" "}
              {(p() as Extract<LinkPhase, { kind: "error" }>).message}
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}

async function persistTabsForProject(projectId: string): Promise<void> {
  const tabs = visibleWorkspaceTabs(projectId);
  const active = activeWorkspaceTab(projectId);
  if (tabs.length === 0) return;
  try {
    await updateProjectWorkspaceTabs(projectId, tabs, active);
  } catch (err) {
    console.error("[T12.2] workspace tabs persist failed:", err);
  }
}

function describePlanFlowError(err: unknown): string {
  if (err instanceof PlanFlowAuthError) {
    return "PlanFlow rejected this token. Re-enter and verify above.";
  }
  if (err instanceof PlanFlowApiError) {
    return `PlanFlow API responded with HTTP ${err.status}. Try again shortly.`;
  }
  return describeError(err);
}

/* ─── Privacy ───────────────────────────────────────────────────────── */

function PrivacySection(): JSX.Element {
  return (
    <>
      <h2 class="ws-settings-page__section-title">Privacy</h2>
      <div class="ws-settings-page__group">
        <div class="ws-settings-page__row">
          <div>
            <div class="ws-settings-page__lbl">
              Anonymous performance metrics <span class="ws-settings-page__badge">v0.2</span>
            </div>
            <div class="ws-settings-page__hint">
              Cold-start time, memory, and crash counts. No commands, no output, no file names.
            </div>
          </div>
          <Toggle on={false} disabled />
        </div>

        <div class="ws-settings-page__row">
          <div>
            <div class="ws-settings-page__lbl">
              Crash reporting <span class="ws-settings-page__badge">v0.2</span>
            </div>
            <div class="ws-settings-page__hint">
              Send anonymized stack traces when Work Station crashes. Helps us fix bugs we don't see
              in development.
            </div>
          </div>
          <Toggle on={false} disabled />
        </div>

        <div class="ws-settings-page__row col">
          <div>
            <div class="ws-settings-page__lbl">What we don't collect</div>
            <div class="ws-settings-page__hint">
              Command lines, terminal output, file paths, project names, and environment variables
              stay on this machine. Personal-use builds never enable telemetry, even with the
              toggles flipped.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ─── About ─────────────────────────────────────────────────────────── */

function AboutSection(): JSX.Element {
  const version = "0.1.0";
  return (
    <>
      <h2 class="ws-settings-page__section-title">About</h2>
      <div class="ws-settings-page__group">
        <div class="ws-settings-page__about">
          <div class="ws-settings-page__about-title">Work Station</div>
          <div class="ws-settings-page__about-version">Version {version}</div>
          <div class="ws-settings-page__about-meta">Tauri + Rust + SolidJS</div>
        </div>
        <div class="ws-settings-page__row col">
          <div class="ws-settings-page__hint">MIT licensed. Source available on GitHub.</div>
        </div>
      </div>
    </>
  );
}

/* ─── Mobile pairing ────────────────────────────────────────────────── */

type TunnelState =
  | { state: "disabled" }
  | { state: "starting" }
  | { state: "running"; url: string }
  | { state: "failed"; reason: string }
  | { state: "unavailable"; reason: string };

interface PairingInfo {
  bound_host: string;
  bound_port: number;
  bound_to_loopback: boolean;
  lan_addresses: string[];
  token: string;
  tunnel: TunnelState;
}

const MOBILE_ORIGIN_STORAGE_KEY = "ws.mobile.pairingOrigin";
const DEFAULT_MOBILE_ORIGIN = "https://mobile-iota-sand.vercel.app";

function MobileSection(): JSX.Element {
  const [info, setInfo] = createSignal<PairingInfo | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [pwaOrigin, setPwaOrigin] = createSignal<string>(
    (typeof localStorage !== "undefined" && localStorage.getItem(MOBILE_ORIGIN_STORAGE_KEY)) ||
      DEFAULT_MOBILE_ORIGIN,
  );
  const [chosenHost, setChosenHost] = createSignal<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [revealToken, setRevealToken] = createSignal(false);
  const [copied, setCopied] = createSignal<"url" | "host" | "token" | null>(null);

  // Persist the PWA origin so the user only types it once.
  createEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(MOBILE_ORIGIN_STORAGE_KEY, pwaOrigin().trim());
  });

  async function load(initial = false): Promise<void> {
    if (initial) setLoading(true);
    setError(null);
    try {
      const result = await invoke<PairingInfo | null>("get_pairing_info");
      setInfo(result);
      if (result && !chosenHost()) {
        const preferred = result.lan_addresses[0] ?? result.bound_host;
        setChosenHost(preferred);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (initial) setLoading(false);
    }
  }

  onMount(() => {
    void load(true);
    // Poll fast while the tunnel is starting — cloudflared takes 1-3s
    // to publish the quick-tunnel URL, and the user is staring at the
    // Settings panel waiting for the QR to render. Once it resolves,
    // keep polling slowly so the watchdog's URL changes (after a
    // tunnel-restart) propagate to the QR without requiring the user
    // to reopen the panel.
    let fast = true;
    let id = setInterval(tick, 1500);
    function tick() {
      const tunnel = info()?.tunnel?.state;
      if (fast && (tunnel === "running" || tunnel === "failed" || tunnel === "unavailable")) {
        clearInterval(id);
        fast = false;
        id = setInterval(tick, 10_000);
      }
      void load();
    }
    onCleanup(() => clearInterval(id));
  });

  // The host encoded in the QR. Cloudflare quick tunnel (HTTPS, public)
  // is strongly preferred — the PWA is served over HTTPS so a plain
  // `http://<lan-ip>:<port>` would be blocked as mixed content. We
  // fall back to LAN only when the tunnel is unavailable / failed and
  // the user has manually opted into LAN mode by picking an address.
  const effectiveHostUrl = createMemo<string | null>(() => {
    const i = info();
    if (!i) return null;
    if (i.tunnel.state === "running") return i.tunnel.url;
    const host = chosenHost();
    if (!host) return null;
    return `http://${host}:${i.bound_port}`;
  });

  const pairingUrl = createMemo<string | null>(() => {
    const i = info();
    const hostUrl = effectiveHostUrl();
    const origin = pwaOrigin().trim().replace(/\/+$/, "");
    if (!i || !hostUrl || !origin) return null;
    const url = new URL(origin);
    url.searchParams.set("h", hostUrl);
    url.searchParams.set("t", i.token);
    return url.toString();
  });

  const wsHostUrl = effectiveHostUrl;

  // Regenerate the QR whenever the URL changes. `errorCorrectionLevel: "M"`
  // is the sweet spot — still scans cleanly through a phone case, doesn't
  // blow up the QR density for the ~120 char payload.
  createEffect(() => {
    const url = pairingUrl();
    if (!url) {
      setQrDataUrl(null);
      return;
    }
    void QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
      color: { dark: "#0a0a0a", light: "#ffffff" },
    })
      .then(setQrDataUrl)
      .catch((err: unknown) => {
        console.error("[pairing] qr render failed", err);
        setQrDataUrl(null);
      });
  });

  async function copy(value: string, what: "url" | "host" | "token"): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied((cur) => (cur === what ? null : cur)), 1500);
    } catch (err) {
      console.error("[pairing] clipboard write failed", err);
    }
  }

  return (
    <>
      <h2 class="ws-settings-page__section-title">Mobile pairing</h2>
      <div class="ws-settings-page__group">
        <div class="ws-settings-page__row col">
          <div>
            <div class="ws-settings-page__lbl">Pair the companion PWA</div>
            <div class="ws-settings-page__hint">
              Scan this QR with the phone running{" "}
              <span style={{ "font-family": "var(--font-mono)" }}>{pwaOrigin()}</span> — either with
              the camera app (opens the PWA pre-filled) or with the in-app <em>Scan pairing QR</em>{" "}
              button on the auth screen. The token never leaves your LAN.
            </div>
          </div>
        </div>

        <Show when={!loading() && info()}>
          {(i) => {
            const tunnel = () => i().tunnel;
            return (
              <Switch>
                <Match when={tunnel().state === "running"}>
                  <div
                    class="ws-settings-page__row col"
                    style={{
                      border: "1px solid var(--success, #2ea043)",
                      "border-radius": "8px",
                      padding: "12px",
                      background: "color-mix(in srgb, var(--success, #2ea043) 8%, transparent)",
                    }}
                  >
                    <div style={{ color: "var(--success, #2ea043)", "font-weight": 600 }}>
                      Cloudflare tunnel connected
                    </div>
                    <div
                      class="ws-settings-page__hint"
                      style={{ "font-family": "var(--font-mono)", "word-break": "break-all" }}
                    >
                      {tunnel().state === "running" ? (tunnel() as { url: string }).url : ""}
                    </div>
                  </div>
                </Match>
                <Match when={tunnel().state === "starting"}>
                  <div class="ws-settings-page__hint">
                    Opening Cloudflare quick tunnel… the QR will appear in a moment.
                  </div>
                </Match>
                <Match when={tunnel().state === "unavailable"}>
                  <div
                    class="ws-settings-page__row col"
                    style={{
                      border: "1px solid var(--warning)",
                      "border-radius": "8px",
                      padding: "12px",
                      background: "color-mix(in srgb, var(--warning) 8%, transparent)",
                    }}
                  >
                    <div style={{ color: "var(--warning)", "font-weight": 600 }}>
                      Cloudflare tunnel unavailable
                    </div>
                    <div class="ws-settings-page__hint">
                      {(tunnel() as { reason: string }).reason}. Falling back to LAN — the phone
                      must be on the same Wi-Fi <em>and</em> the PWA must be loaded over HTTP (not
                      the public HTTPS origin) for the connection to succeed.
                    </div>
                  </div>
                </Match>
                <Match when={tunnel().state === "failed"}>
                  <div
                    class="ws-settings-page__row col"
                    style={{
                      border: "1px solid var(--error)",
                      "border-radius": "8px",
                      padding: "12px",
                      background: "color-mix(in srgb, var(--error) 8%, transparent)",
                    }}
                  >
                    <div style={{ color: "var(--error)", "font-weight": 600 }}>
                      Cloudflare tunnel failed
                    </div>
                    <div class="ws-settings-page__hint">
                      {(tunnel() as { reason: string }).reason}. Restart Work Station to retry, or
                      use LAN fallback below.
                    </div>
                  </div>
                </Match>
              </Switch>
            );
          }}
        </Show>

        <Show when={loading()}>
          <div class="ws-settings-page__hint">Loading pairing info…</div>
        </Show>
        <Show when={error()}>
          <div class="ws-settings-page__hint" style={{ color: "var(--error)" }}>
            Couldn’t read pairing info: {error()}
          </div>
        </Show>

        <Show when={!loading() && !error() && !info()}>
          <div
            class="ws-settings-page__row col"
            style={{
              border: "1px solid var(--error)",
              "border-radius": "8px",
              padding: "12px",
              background: "color-mix(in srgb, var(--error) 8%, transparent)",
            }}
          >
            <div style={{ color: "var(--error)", "font-weight": 600 }}>
              The WebSocket bridge isn’t running on this instance.
            </div>
            <div class="ws-settings-page__hint">
              Another Work Station process is probably holding port 7420 (the installed app is the
              most common culprit). Quit any extra copies, then restart this one. Check the dev
              console for{" "}
              <span style={{ "font-family": "var(--font-mono)" }}>ws bridge: init failed</span> to
              confirm.
            </div>
            <button
              type="button"
              class="ws-settings-page__btn ws-settings-page__btn--ghost"
              style={{ "align-self": "flex-start", "margin-top": "8px" }}
              onClick={() => void load()}
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={!loading() && info()}>
          {(i) => (
            <>
              <div class="ws-settings-page__row col">
                <div class="ws-settings-page__lbl">PWA origin</div>
                <input
                  class="ws-settings-page__input"
                  type="url"
                  value={pwaOrigin()}
                  spellcheck={false}
                  autocapitalize="none"
                  onInput={(e) => setPwaOrigin(e.currentTarget.value)}
                  placeholder="https://mobile-iota-sand.vercel.app"
                />
                <div class="ws-settings-page__hint">
                  Where the mobile PWA is hosted. Default is the public Vercel build.
                </div>
              </div>

              <Show when={i().lan_addresses.length > 1}>
                <div class="ws-settings-page__row col">
                  <div class="ws-settings-page__lbl">LAN address</div>
                  <div class="ws-settings-page__seg" role="radiogroup">
                    <For each={i().lan_addresses}>
                      {(addr) => (
                        <button
                          type="button"
                          class="ws-settings-page__seg-btn"
                          role="radio"
                          aria-checked={chosenHost() === addr}
                          data-on={chosenHost() === addr ? "true" : undefined}
                          onClick={() => setChosenHost(addr)}
                          style={{ "font-family": "var(--font-mono)" }}
                        >
                          {addr}
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="ws-settings-page__hint">
                    Pick the interface your phone shares — usually the one matching your Wi-Fi
                    router subnet.
                  </div>
                </div>
              </Show>

              <div
                class="ws-settings-page__row"
                style={{ "justify-content": "center", padding: "16px 0" }}
              >
                <Show
                  when={qrDataUrl()}
                  fallback={
                    <div
                      style={{
                        width: "240px",
                        height: "240px",
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        background: "var(--bg-elevated)",
                        "border-radius": "12px",
                        color: "var(--text-tertiary)",
                        "font-size": "12px",
                      }}
                    >
                      {pairingUrl() ? "Rendering QR…" : "Enter a PWA origin first"}
                    </div>
                  }
                >
                  {(src) => (
                    <img
                      src={src()}
                      alt="Pairing QR code"
                      width="240"
                      height="240"
                      style={{ "border-radius": "12px", background: "#fff" }}
                    />
                  )}
                </Show>
              </div>

              <div class="ws-settings-page__row col">
                <div class="ws-settings-page__lbl">Pairing link</div>
                <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                  <input
                    class="ws-settings-page__input"
                    readonly
                    value={pairingUrl() ?? ""}
                    spellcheck={false}
                    style={{ "font-family": "var(--font-mono)", flex: 1 }}
                  />
                  <button
                    type="button"
                    class="ws-settings-page__btn ws-settings-page__btn--ghost"
                    onClick={() => {
                      const url = pairingUrl();
                      if (url) void copy(url, "url");
                    }}
                  >
                    {copied() === "url" ? "Copied" : "Copy"}
                  </button>
                </div>
                <div class="ws-settings-page__hint">
                  Tap this on the phone too — the PWA auto-pairs from the query string.
                </div>
              </div>

              <div class="ws-settings-page__row col">
                <div class="ws-settings-page__lbl">Host (manual entry)</div>
                <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                  <input
                    class="ws-settings-page__input"
                    readonly
                    value={wsHostUrl() ?? ""}
                    spellcheck={false}
                    style={{ "font-family": "var(--font-mono)", flex: 1 }}
                  />
                  <button
                    type="button"
                    class="ws-settings-page__btn ws-settings-page__btn--ghost"
                    onClick={() => {
                      const h = wsHostUrl();
                      if (h) void copy(h, "host");
                    }}
                  >
                    {copied() === "host" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              <div class="ws-settings-page__row col">
                <div class="ws-settings-page__lbl">Bearer token</div>
                <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                  <input
                    class="ws-settings-page__input"
                    readonly
                    value={revealToken() ? i().token : "•".repeat(43)}
                    spellcheck={false}
                    style={{ "font-family": "var(--font-mono)", flex: 1 }}
                  />
                  <button
                    type="button"
                    class="ws-settings-page__btn ws-settings-page__btn--ghost"
                    onClick={() => setRevealToken((v) => !v)}
                  >
                    {revealToken() ? "Hide" : "Show"}
                  </button>
                  <button
                    type="button"
                    class="ws-settings-page__btn ws-settings-page__btn--ghost"
                    onClick={() => void copy(i().token, "token")}
                  >
                    {copied() === "token" ? "Copied" : "Copy"}
                  </button>
                </div>
                <div class="ws-settings-page__hint">
                  Anyone with this token can drive your terminals. Keep it on your phone, not in
                  chats / screenshots.
                </div>
              </div>
            </>
          )}
        </Show>
      </div>
    </>
  );
}

/* ─── Primitives ────────────────────────────────────────────────────── */

function Segmented<T extends string>(props: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <div class="ws-settings-page__seg" role="radiogroup">
      <For each={props.options}>
        {(opt) => (
          <button
            type="button"
            class="ws-settings-page__seg-btn"
            role="radio"
            aria-checked={props.value === opt.id}
            data-on={props.value === opt.id ? "true" : undefined}
            onClick={() => props.onChange(opt.id)}
          >
            {opt.label}
          </button>
        )}
      </For>
    </div>
  );
}

function Toggle(props: {
  on: boolean;
  disabled?: boolean;
  onChange?: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      class="ws-settings-page__toggle"
      data-on={props.on ? "true" : undefined}
      disabled={props.disabled}
      aria-pressed={props.on}
      onClick={() => !props.disabled && props.onChange?.(!props.on)}
    />
  );
}
