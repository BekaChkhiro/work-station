import { createSignal, createEffect, onCleanup } from "solid-js";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "ws.theme";

const readStored = (): ThemeMode => {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "dark" || v === "light" || v === "system" ? v : "system";
};

const systemPrefersDark = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

const initialMode = readStored();
const initialResolved: ResolvedTheme =
  initialMode === "system" ? (systemPrefersDark() ? "dark" : "light") : initialMode;

const [mode, setModeSignal] = createSignal<ThemeMode>(initialMode);
const [resolved, setResolved] = createSignal<ResolvedTheme>(initialResolved);

// Eagerly stamp data-theme before the first render so CSS vars are live
// from frame 0 — avoids unstyled flash when effects haven't flushed yet.
if (typeof document !== "undefined") {
  document.documentElement.dataset.theme = initialResolved;
}

createEffect(() => {
  const m = mode();
  const r: ResolvedTheme = m === "system" ? (systemPrefersDark() ? "dark" : "light") : m;
  setResolved(r);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = r;
  }
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, m);
  }
});

if (typeof window !== "undefined") {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (mode() === "system") setResolved(mql.matches ? "dark" : "light");
  };
  mql.addEventListener("change", onChange);
  onCleanup(() => mql.removeEventListener("change", onChange));
}

export const themeMode = mode;
export const resolvedTheme = resolved;
export const setThemeMode = (m: ThemeMode) => setModeSignal(m);
