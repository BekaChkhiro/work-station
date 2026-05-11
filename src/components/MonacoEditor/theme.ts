// T13.7 — Monaco themes wired to app design tokens.
//
// Monaco resolves theme colours from a literal palette at `defineTheme` time
// — it doesn't read CSS variables. We mirror the relevant `tokens.css`
// values here so the editor's chrome (background, gutter, cursor, selection)
// matches `--bg-canvas` etc. Token rules (keywords, strings, comments) map
// to the existing semantic colours (accent / warning / info / success /
// text-tertiary), so the editor shares the rest of the app's palette.
//
// `ensureEditorThemes()` is idempotent — Monaco accepts repeated
// `defineTheme` calls but the work is wasted, so we guard with a module
// flag. Callers can switch themes at runtime with
// `monaco.editor.setTheme(editorThemeForApp(resolvedTheme))`.

import * as monaco from "monaco-editor";
import type { ResolvedTheme } from "../../stores/theme";

export const EDITOR_THEME_DARK = "ws-dark";
export const EDITOR_THEME_LIGHT = "ws-light";

const DARK_THEME_DATA: monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "e6e7e9" },
    { token: "comment", foreground: "5b626b", fontStyle: "italic" },
    { token: "keyword", foreground: "7cc8c8" },
    { token: "string", foreground: "d8b06a" },
    { token: "number", foreground: "c9a5f5" },
    { token: "type", foreground: "7fc99a" },
    { token: "type.identifier", foreground: "7fc99a" },
    { token: "class", foreground: "7fc99a" },
    { token: "interface", foreground: "7fc99a" },
    { token: "enum", foreground: "7fc99a" },
    { token: "function", foreground: "7eb6d2" },
    { token: "variable", foreground: "e6e7e9" },
    { token: "variable.predefined", foreground: "7eb6d2" },
    { token: "constant", foreground: "c9a5f5" },
    { token: "regexp", foreground: "df8b6e" },
    { token: "operator", foreground: "9098a1" },
    { token: "delimiter", foreground: "9098a1" },
    { token: "tag", foreground: "7cc8c8" },
    { token: "attribute.name", foreground: "7fc99a" },
    { token: "attribute.value", foreground: "d8b06a" },
  ],
  colors: {
    "editor.background": "#0b0c0e",
    "editor.foreground": "#e6e7e9",
    "editorLineNumber.foreground": "#5b626b",
    "editorLineNumber.activeForeground": "#9098a1",
    "editorCursor.foreground": "#5cc8c8",
    "editor.selectionBackground": "#5cc8c838",
    "editor.inactiveSelectionBackground": "#5cc8c81f",
    "editor.lineHighlightBackground": "#ffffff08",
    "editor.lineHighlightBorder": "#00000000",
    "editorIndentGuide.background1": "#ffffff0b",
    "editorIndentGuide.activeBackground1": "#ffffff1f",
    "editorWhitespace.foreground": "#ffffff10",
    "editorWidget.background": "#181b1f",
    "editorWidget.border": "#ffffff17",
    "editorSuggestWidget.background": "#181b1f",
    "editorSuggestWidget.border": "#ffffff17",
    "editorSuggestWidget.selectedBackground": "#ffffff0f",
    "editorHoverWidget.background": "#181b1f",
    "editorHoverWidget.border": "#ffffff17",
    "scrollbarSlider.background": "#ffffff0d",
    "scrollbarSlider.hoverBackground": "#ffffff1a",
    "scrollbarSlider.activeBackground": "#ffffff26",
    "editorBracketMatch.background": "#5cc8c826",
    "editorBracketMatch.border": "#5cc8c855",
    focusBorder: "#5cc8c88c",
  },
};

const LIGHT_THEME_DATA: monaco.editor.IStandaloneThemeData = {
  base: "vs",
  inherit: true,
  rules: [
    { token: "", foreground: "1b1d20" },
    { token: "comment", foreground: "8a9098", fontStyle: "italic" },
    { token: "keyword", foreground: "2f7c7c" },
    { token: "string", foreground: "8a6420" },
    { token: "number", foreground: "6b3fb0" },
    { token: "type", foreground: "2f7a4c" },
    { token: "type.identifier", foreground: "2f7a4c" },
    { token: "class", foreground: "2f7a4c" },
    { token: "interface", foreground: "2f7a4c" },
    { token: "enum", foreground: "2f7a4c" },
    { token: "function", foreground: "2c6da3" },
    { token: "variable", foreground: "1b1d20" },
    { token: "variable.predefined", foreground: "2c6da3" },
    { token: "constant", foreground: "6b3fb0" },
    { token: "regexp", foreground: "a44a2a" },
    { token: "operator", foreground: "565c63" },
    { token: "delimiter", foreground: "565c63" },
    { token: "tag", foreground: "2f7c7c" },
    { token: "attribute.name", foreground: "2f7a4c" },
    { token: "attribute.value", foreground: "8a6420" },
  ],
  colors: {
    "editor.background": "#f6f5f1",
    "editor.foreground": "#1b1d20",
    "editorLineNumber.foreground": "#8a9098",
    "editorLineNumber.activeForeground": "#565c63",
    "editorCursor.foreground": "#2f7c7c",
    "editor.selectionBackground": "#2f7c7c33",
    "editor.inactiveSelectionBackground": "#2f7c7c1c",
    "editor.lineHighlightBackground": "#0000000a",
    "editor.lineHighlightBorder": "#00000000",
    "editorIndentGuide.background1": "#0000000e",
    "editorIndentGuide.activeBackground1": "#0000002b",
    "editorWhitespace.foreground": "#00000014",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#0000001a",
    "editorSuggestWidget.background": "#ffffff",
    "editorSuggestWidget.border": "#0000001a",
    "editorSuggestWidget.selectedBackground": "#00000010",
    "editorHoverWidget.background": "#ffffff",
    "editorHoverWidget.border": "#0000001a",
    "scrollbarSlider.background": "#00000014",
    "scrollbarSlider.hoverBackground": "#00000026",
    "scrollbarSlider.activeBackground": "#00000040",
    "editorBracketMatch.background": "#2f7c7c1f",
    "editorBracketMatch.border": "#2f7c7c66",
    focusBorder: "#2f7c7c8c",
  },
};

let registered = false;

/** Idempotent — registers `ws-dark` and `ws-light` once per page. */
export function ensureEditorThemes(): void {
  if (registered) return;
  registered = true;
  monaco.editor.defineTheme(EDITOR_THEME_DARK, DARK_THEME_DATA);
  monaco.editor.defineTheme(EDITOR_THEME_LIGHT, LIGHT_THEME_DATA);
}

/** Map app theme (`"dark"` | `"light"`) to the registered Monaco theme id. */
export function editorThemeForApp(resolved: ResolvedTheme): string {
  return resolved === "light" ? EDITOR_THEME_LIGHT : EDITOR_THEME_DARK;
}
