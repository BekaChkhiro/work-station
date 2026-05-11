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
