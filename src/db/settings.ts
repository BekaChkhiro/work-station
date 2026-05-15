// T3.4: typed get/set wrapper over the `app_settings` key/value table.
//
// Storage layout (see migrations/0003_app_settings.sql):
//   app_settings(key TEXT PK, value TEXT)
//
// Values are always JSON-encoded TEXT. Each known key registers a Zod schema
// plus a default — `getSetting` parses with the schema and falls back to the
// default on missing rows, malformed JSON, or schema mismatch, so corrupt
// values never crash callers (T3.4 acceptance: "Get/set wrapper handles type
// coercion safely"). `setSetting` validates input through the same schema so
// we can never persist a value the reader would later reject.
//
// Adding a new setting: extend SETTINGS with a key → { schema, default }
// entry. The `SettingKey`/`SettingValue<K>` types flow through automatically.
import { z } from "zod";

import { db } from "./index";

const ThemeSchema = z.enum(["light", "dark", "system"]);
// T8.7: rebound hotkeys live as `{ actionId: serializedBinding }`. The
// serialized form is the hotkey registry's compact wire format —
// `mod+shift+w` / `mod+alt+ArrowLeft` etc. The registry parses on load
// and writes back on every rebind, so an entry here always reflects the
// user override; an absent entry falls back to the registry default.
const HotkeysSchema = z.record(z.string(), z.string());
const ScrollbackSchema = z.number().int().positive().max(1_000_000);
const ProjectIdSchema = z.string().min(1).nullable();
const FallbackCliSchema = z.string().min(1).nullable();
const DensitySchema = z.enum(["compact", "comfortable"]);
const MonoFontSchema = z.enum(["jetbrains", "geist", "berkeley", "system"]);
const UiFontSizeSchema = z.number().int().min(12).max(16);
// T11.3: per-integration verified-state cache. Keys are integration ids
// (e.g. "planflow", "github"); unknown keys are tolerated so a future
// integration can ship without a settings migration. The map is rewritten
// in whole on every save/clear via the helpers in `integrations/status.ts`.
//
// T11.8: `needsReauthAt` is set when a long-running integration call
// returned 401/403 — the banner in the affected tab and the
// "Re-enter token" mode in Settings both read from this field. A
// successful Verify clears it and drains the in-flight retry queue.
const IntegrationStatusSchema = z.record(
  z.string(),
  z.object({
    verifiedAt: z.number().int(),
    accountLabel: z.string(),
    // T12.2 — PlanFlow's card displays both name and email when the verifier
    // can resolve them; other integrations leave these unset and the card
    // falls back to `accountLabel` alone.
    accountName: z.string().nullable().optional(),
    accountEmail: z.string().nullable().optional(),
    needsReauthAt: z.number().int().nullable().optional(),
  }),
);
// T11.10: a one-time intro card sits on top of the Integrations panel
// reassuring the user that tokens never leave the device. Once dismissed
// we don't show it again — toggled back on by clearing the flag.
const IntegrationsIntroDismissedSchema = z.boolean();
// T13.4 — debounced auto-save delay in milliseconds for the editor. `0`
// disables auto-save entirely (default); any positive value enables it and
// is treated as the debounce window after the last keystroke. Capped at
// 60s so a typo in the settings UI can't push saves into the next year.
const EditorAutosaveMsSchema = z.number().int().min(0).max(60_000);
// T13.6 — per-project open editor tabs. Keyed by projectId; each entry
// records the absolute file paths that were open (in tab order) and which
// of them was active so a relaunch restores the same view. Paths that no
// longer exist on disk fail their re-open gracefully and the entry is
// dropped from the restored list on first save. Stored globally in
// `app_settings` rather than on the `projects` table to keep the schema
// stable — editor restoration is a soft UI nicety, not load-bearing data.
const EditorTabsByProjectSchema = z.record(
  z.string(),
  z.object({
    paths: z.array(z.string()),
    active: z.string().nullable(),
  }),
);
// T19.4 — cloud mode (Phase 19). The desktop talks to a user-owned VPS
// running `cloud-agent` (T19.2) over WebSocket through a Cloudflare
// Tunnel. The toggle is a single switch: off → local PTYs + local SQLite
// (default), on → all workspace data is sourced from the remote agent.
//
// Token storage stays in the OS keychain (T11.2 pattern) so the
// pairing secret never lands in the SQLite browser — only the URL and
// non-secret status metadata live here.
const CloudModeSchema = z.boolean();
// Absolute wss:// URL the desktop dials. Validated as a non-empty
// string here; the Settings UI (T19.15) does shape-level URL parsing
// before write so we don't reject pre-pairing test values.
const CloudAgentUrlSchema = z.string().min(1).nullable();
// Mirrors the integration_status shape: a successful pairing stamps
// `pairedAt` + the agent's advertised version, `lastHandshakeAt`
// updates on every WS reconnect, and `needsRepairAt` flips on when
// the agent returns 401/handshake-rejected so the Settings card can
// surface a Re-pair affordance (T19.15). null until first pair.
const CloudAgentStatusSchema = z
  .object({
    pairedAt: z.number().int(),
    agentVersion: z.string().nullable().optional(),
    lastHandshakeAt: z.number().int().nullable().optional(),
    needsRepairAt: z.number().int().nullable().optional(),
  })
  .nullable();

interface SettingDef<T> {
  schema: z.ZodType<T>;
  default: T;
}

function def<T>(schema: z.ZodType<T>, defaultValue: T): SettingDef<T> {
  return { schema, default: defaultValue };
}

// Per PROJECT_PLAN T3.4: theme, hotkeys, last-active project, scrollback size,
// default fallback CLI. Default-fallback-CLI stays nullable so the platform
// default chosen at runtime (T2.x) doesn't get baked into storage.
export const SETTINGS = {
  theme: def(ThemeSchema, "dark" as z.infer<typeof ThemeSchema>),
  hotkeys: def(HotkeysSchema, {} as z.infer<typeof HotkeysSchema>),
  last_active_project: def(ProjectIdSchema, null as z.infer<typeof ProjectIdSchema>),
  scrollback_size: def(ScrollbackSchema, 10_000),
  default_fallback_cli: def(FallbackCliSchema, null as z.infer<typeof FallbackCliSchema>),
  density: def(DensitySchema, "comfortable" as z.infer<typeof DensitySchema>),
  mono_font: def(MonoFontSchema, "jetbrains" as z.infer<typeof MonoFontSchema>),
  ui_font_size: def(UiFontSizeSchema, 13),
  integration_status: def(IntegrationStatusSchema, {} as z.infer<typeof IntegrationStatusSchema>),
  integrations_intro_dismissed: def(IntegrationsIntroDismissedSchema, false),
  editor_autosave_ms: def(EditorAutosaveMsSchema, 0),
  editor_tabs_by_project: def(
    EditorTabsByProjectSchema,
    {} as z.infer<typeof EditorTabsByProjectSchema>,
  ),
  // T19.4 — Phase 19 cloud mode. Defaults keep the app in local mode so a
  // fresh install behaves exactly like pre-T19.4 builds.
  cloud_mode: def(CloudModeSchema, false),
  cloud_agent_url: def(CloudAgentUrlSchema, null as z.infer<typeof CloudAgentUrlSchema>),
  cloud_agent_status: def(CloudAgentStatusSchema, null as z.infer<typeof CloudAgentStatusSchema>),
} as const satisfies Record<string, SettingDef<unknown>>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> =
  (typeof SETTINGS)[K] extends SettingDef<infer T> ? T : never;

interface SettingRow {
  value: string;
}

/**
 * Read a setting. Returns the registered default when:
 *  - the row is missing,
 *  - the stored TEXT is not valid JSON,
 *  - the parsed value fails the registered schema.
 */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const definition = SETTINGS[key] as SettingDef<SettingValue<K>>;
  const handle = await db();
  const rows = await handle.select<SettingRow[]>(
    "SELECT value FROM app_settings WHERE key = ? LIMIT 1",
    [key],
  );
  const raw = rows[0]?.value;
  if (raw == null) return definition.default;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return definition.default;
  }
  const result = definition.schema.safeParse(parsed);
  return result.success ? result.data : definition.default;
}

/**
 * Write a setting. Throws `z.ZodError` if `value` does not match the
 * registered schema — this keeps the table free of values the reader would
 * later silently reject.
 */
export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const definition = SETTINGS[key] as SettingDef<SettingValue<K>>;
  const validated = definition.schema.parse(value);
  const handle = await db();
  await handle.execute(
    "INSERT INTO app_settings (key, value) VALUES (?, ?)\n     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(validated)],
  );
}

/** Remove a setting; subsequent reads return the registered default. */
export async function deleteSetting(key: SettingKey): Promise<void> {
  const handle = await db();
  await handle.execute("DELETE FROM app_settings WHERE key = ?", [key]);
}
