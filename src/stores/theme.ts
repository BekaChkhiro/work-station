// T8.3 / T8.7 — Theme store.
//
// Source of truth is the SQLite `app_settings.theme` row (T8.7). To keep the
// pre-paint flash to zero, we *also* mirror the value to localStorage on every
// change and read localStorage synchronously at module load — SQL queries are
// async and would race the first paint. On boot we kick an async hydrate that
// reconciles with SQL (and one-time-migrates an existing localStorage value
// when the SQL row is absent).

import { createSignal, createEffect, untrack } from "solid-js";
import { getSetting, setSetting } from "../db/settings";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "ws.theme";

const readStored = (): ThemeMode => {
  if (typeof localStorage === "undefined") return "dark";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "dark" || v === "light" || v === "system" ? v : "dark";
};

const systemPrefersDark = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

const resolveMode = (m: ThemeMode): ResolvedTheme =>
  m === "system" ? (systemPrefersDark() ? "dark" : "light") : m;

const stampTheme = (r: ResolvedTheme): void => {
  setResolved(r);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = r;
  }
};

const initialMode = readStored();
const initialResolved = resolveMode(initialMode);

const [mode, setModeSignal] = createSignal<ThemeMode>(initialMode);
const [resolved, setResolved] = createSignal<ResolvedTheme>(initialResolved);

// Eagerly stamp data-theme before the first render so CSS vars are live
// from frame 0 — avoids unstyled flash when effects haven't flushed yet.
if (typeof document !== "undefined") {
  document.documentElement.dataset.theme = initialResolved;
}

// Suppress writes to SQL when we're updating the signal from a hydrate.
let hydrating = false;

createEffect(() => {
  const m = mode();
  stampTheme(resolveMode(m));
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, m);
  }
  if (hydrating) return;
  // Fire-and-forget: SQL persistence trails the in-memory update. A write
  // failure logs but doesn't surface — localStorage still carries the value
  // forward to the next session.
  void setSetting("theme", m).catch((err) => {
    console.warn("[theme] failed to persist theme to app_settings", err);
  });
});

// Module-level singleton: one MediaQueryList listener for the app's
// lifetime. There's no component / reactive root to bind cleanup to here —
// `onCleanup` at module scope is a no-op in Solid — so we deliberately
// leave the listener attached. The store outlives any component anyway.
if (typeof window !== "undefined") {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", () => {
    if (mode() === "system") stampTheme(mql.matches ? "dark" : "light");
  });
}

// One-shot SQL hydrate. If `app_settings.theme` exists, it wins over the
// localStorage seed. If it doesn't, we write the seed (or default) up so
// future reads see it — this is the localStorage→SQL migration.
async function hydrateFromSql(): Promise<void> {
  try {
    const fromSql = await getSetting("theme");
    if (fromSql !== mode()) {
      hydrating = true;
      setModeSignal(fromSql);
      hydrating = false;
    }
    // Ensure SQL has a row even if the user has never opened settings.
    await setSetting("theme", fromSql);
  } catch (err) {
    console.warn("[theme] hydrate from app_settings failed", err);
  }
}

if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  void untrack(() => hydrateFromSql());
}

export const themeMode = mode;
export const resolvedTheme = resolved;
export const setThemeMode = (m: ThemeMode) => setModeSignal(m);
