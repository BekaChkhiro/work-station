import { createSignal, createEffect } from "solid-js";

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

createEffect(() => {
  const m = mode();
  stampTheme(resolveMode(m));
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, m);
  }
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

export const themeMode = mode;
export const resolvedTheme = resolved;
export const setThemeMode = (m: ThemeMode) => setModeSignal(m);
