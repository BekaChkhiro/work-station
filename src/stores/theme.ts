import { createSignal, createEffect } from "solid-js";
import { getSetting, setSetting } from "../db/settings";

export type Theme = "dark" | "light" | "system";

const STORAGE_KEY = "ws-theme";

function resolveSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getFallbackTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  if (stored && ["dark", "light", "system"].includes(stored)) {
    return stored;
  }
  return "dark";
}

function applyTheme(theme: Theme) {
  const resolved = theme === "system" ? resolveSystemTheme() : theme;
  document.documentElement.setAttribute("data-theme", resolved === "light" ? "light" : "dark");
}

const [theme, setThemeSignal] = createSignal<Theme>(getFallbackTheme());

export { theme };

export function setTheme(next: Theme) {
  localStorage.setItem(STORAGE_KEY, next);
  setThemeSignal(next);
  // Persist to SQLite (fire-and-forget; DB may not be ready yet)
  setSetting("theme", next).catch(() => {
    // Silently ignore — localStorage already holds the value
  });
}

export function toggleTheme() {
  const current = theme();
  const next = current === "dark" ? "light" : "dark";
  setTheme(next);
}

/** Load theme preference from SQLite, falling back to localStorage. */
export async function loadThemeFromDb(): Promise<void> {
  const dbValue = await getSetting("theme");
  const next: Theme =
    dbValue && ["dark", "light", "system"].includes(dbValue)
      ? (dbValue as Theme)
      : getFallbackTheme();
  setThemeSignal(next);
}

// Apply on load and reactively on change
createEffect(() => {
  applyTheme(theme());
});

// Listen for system changes when in "system" mode
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme() === "system") {
    applyTheme("system");
  }
});
