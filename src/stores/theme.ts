import { createSignal, createEffect } from "solid-js";

export type Theme = "dark" | "light" | "system";

function getInitialTheme(): Theme {
  const stored = localStorage.getItem("ws-theme") as Theme | null;
  if (stored && ["dark", "light", "system"].includes(stored)) {
    return stored;
  }
  return "dark";
}

function resolveSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme) {
  const resolved = theme === "system" ? resolveSystemTheme() : theme;
  document.documentElement.setAttribute(
    "data-theme",
    resolved === "light" ? "light" : "dark"
  );
}

const [theme, setThemeSignal] = createSignal<Theme>(getInitialTheme());

export { theme };

export function setTheme(next: Theme) {
  localStorage.setItem("ws-theme", next);
  setThemeSignal(next);
}

export function toggleTheme() {
  const current = theme();
  const next = current === "dark" ? "light" : "dark";
  setTheme(next);
}

// Apply on load and reactively on change
createEffect(() => {
  applyTheme(theme());
});

// Listen for system changes when in "system" mode
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    if (theme() === "system") {
      applyTheme("system");
    }
  });
