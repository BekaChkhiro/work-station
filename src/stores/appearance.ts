// T8.7 — Appearance store. Density, mono font, UI font size — all persisted
// to `app_settings` and applied to the document root so CSS tokens
// (`[data-density]`, `--font-mono`, `--fs-base`) pick them up. Hydrates from
// SQL on boot but seeds synchronously from defaults so first paint is stable.

import { createEffect, createSignal } from "solid-js";
import { getSetting, setSetting, SETTINGS } from "../db/settings";

export type Density = "compact" | "comfortable";
export type MonoFont = "jetbrains" | "geist" | "berkeley" | "system";

const MONO_STACK: Record<MonoFont, string> = {
  jetbrains: '"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace',
  geist: '"Geist Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace',
  berkeley: '"Berkeley Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace',
  system: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace',
};

const [density, setDensitySignal] = createSignal<Density>(SETTINGS.density.default);
const [monoFont, setMonoFontSignal] = createSignal<MonoFont>(SETTINGS.mono_font.default);
const [uiFontSize, setUiFontSizeSignal] = createSignal<number>(SETTINGS.ui_font_size.default);

const applyDensity = (d: Density): void => {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.density = d;
};
const applyMonoFont = (m: MonoFont): void => {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--font-mono", MONO_STACK[m]);
};
const applyUiFontSize = (s: number): void => {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--fs-base", `${s}px`);
};

applyDensity(SETTINGS.density.default);
applyMonoFont(SETTINGS.mono_font.default);
applyUiFontSize(SETTINGS.ui_font_size.default);

let hydrating = false;

createEffect(() => {
  const d = density();
  applyDensity(d);
  if (hydrating) return;
  void setSetting("density", d).catch((err) =>
    console.warn("[appearance] persist density failed", err),
  );
});

createEffect(() => {
  const m = monoFont();
  applyMonoFont(m);
  if (hydrating) return;
  void setSetting("mono_font", m).catch((err) =>
    console.warn("[appearance] persist mono_font failed", err),
  );
});

createEffect(() => {
  const s = uiFontSize();
  applyUiFontSize(s);
  if (hydrating) return;
  void setSetting("ui_font_size", s).catch((err) =>
    console.warn("[appearance] persist ui_font_size failed", err),
  );
});

async function hydrate(): Promise<void> {
  try {
    const [d, m, s] = await Promise.all([
      getSetting("density"),
      getSetting("mono_font"),
      getSetting("ui_font_size"),
    ]);
    hydrating = true;
    setDensitySignal(d);
    setMonoFontSignal(m);
    setUiFontSizeSignal(s);
    hydrating = false;
  } catch (err) {
    console.warn("[appearance] hydrate failed", err);
  }
}

if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  void hydrate();
}

export const densityMode = density;
export const monoFontMode = monoFont;
export const uiFontSizeMode = uiFontSize;
export const setDensity = (d: Density): void => {
  setDensitySignal(d);
};
export const setMonoFont = (m: MonoFont): void => {
  setMonoFontSignal(m);
};
export const setUiFontSize = (s: number): void => {
  setUiFontSizeSignal(s);
};
