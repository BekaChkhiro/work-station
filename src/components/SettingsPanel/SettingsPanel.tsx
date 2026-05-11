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
  CredentialsError,
  DEFAULT_ACCOUNT,
  Integration,
  IntegrationVerifyError,
  clearIntegrationStatus,
  deleteCredential,
  getCredential,
  getIntegrationStatusMap,
  hasCredential,
  PLANFLOW_DEFAULT_BASE_URL,
  setCredential,
  setIntegrationStatus,
  verifyIntegration,
  type IntegrationId,
  type IntegrationStatusEntry,
} from "../../integrations";

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

type SectionId = "general" | "appearance" | "keys" | "clis" | "integrations" | "privacy" | "about";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "keys", label: "Keybindings" },
  { id: "clis", label: "CLIs" },
  { id: "integrations", label: "Integrations" },
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
  },
  {
    id: Integration.GitHub,
    label: "GitHub",
    description: "Repository overview, pull requests, and workflow runs.",
    endpoint: "api.github.com",
  },
  {
    id: Integration.Vercel,
    label: "Vercel",
    description: "Deployments, build logs, and environment variables.",
    endpoint: "api.vercel.com",
  },
  {
    id: Integration.Neon,
    label: "Neon",
    description: "Branches, connection strings, and SQL queries.",
    endpoint: "console.neon.tech",
  },
  {
    id: Integration.Railway,
    label: "Railway",
    description: "Services, deployments, and live log streams.",
    endpoint: "backboard.railway.app",
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
  });

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
      const { accountLabel } = await verifyIntegration(def.id, token);
      const entry: IntegrationStatusEntry = {
        verifiedAt: Date.now(),
        accountLabel,
      };
      await setIntegrationStatus(def.id, entry);
      patch(def.id, { status: entry, phase: { kind: "idle" } });
    } catch (err) {
      patch(def.id, { phase: { kind: "error", message: describeError(err) } });
    }
  };

  return (
    <>
      <h2 class="ws-settings-page__section-title">Integrations</h2>
      <div class="ws-settings-page__group ws-settings-page__integrations">
        <For each={INTEGRATIONS}>
          {(def) => {
            const row = (): RowState => rows()[def.id] ?? emptyRow();
            const phase = (): Phase => row().phase;
            const busy = (): boolean => phase().kind === "saving" || phase().kind === "verifying";
            const canSave = (): boolean => row().draft.trim().length > 0 && !busy();
            const canVerify = (): boolean => row().hasToken && !busy();
            return (
              <div class="ws-integration" role="group" aria-label={`${def.label} integration`}>
                <div class="ws-integration__head">
                  <div class="ws-integration__title">
                    <div class="ws-settings-page__lbl">{def.label}</div>
                    <div class="ws-settings-page__hint">
                      {def.description} · {def.endpoint}
                    </div>
                  </div>
                  <IntegrationStatusPill row={row()} />
                </div>

                <div class="ws-integration__token">
                  <input
                    type={row().reveal ? "text" : "password"}
                    class="ws-settings-page__input ws-integration__input"
                    placeholder={
                      row().hasToken ? "Paste a new token to replace…" : "Paste API token"
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
  const label = (): string => {
    if (verifying()) return "Checking…";
    if (props.row.status) return `Connected · ${props.row.status.accountLabel}`;
    if (props.row.hasToken) return "Saved · not verified";
    return "Not connected";
  };
  const tone = (): string => {
    if (verifying()) return "checking";
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
