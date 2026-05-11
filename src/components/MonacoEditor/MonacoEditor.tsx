// T13.1: hand-rolled Solid binding for monaco-editor.
//
// No official Solid wrapper exists for monaco, and the React wrappers
// pull in react + DOM diffing for what is fundamentally a controlled
// imperative widget. This component owns the editor lifecycle directly:
//
//   • onMount   — create the model + editor instance, wire change events
//   • createEffect(on(...)) — push prop changes into the live editor
//                              without remounting (value, language,
//                              theme, readOnly)
//   • onCleanup — dispose the change subscription, ResizeObserver, the
//                  editor, and finally the model. Order matters: the
//                  editor holds a reference to the model and must be
//                  torn down first.
//
// Layout: monaco's `automaticLayout: true` polls via setInterval and is
// known to misbehave inside webviews where the host element can be
// detached/reattached (tab switches do exactly that). A scoped
// ResizeObserver — the same pattern Terminal.tsx uses for xterm — is
// both cheaper and more reliable.
//
// Controlled-input pattern: `value` is reactive, but pushing a programmatic
// update back through `setValue` would re-fire `onDidChangeModelContent`,
// which would loop back to the parent. A short `suppressOnChange` guard
// around the programmatic write breaks the loop without needing a deep
// equality check on every keystroke.

import { createEffect, createMemo, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import * as monaco from "monaco-editor";
import { addMenuActionListener } from "../../menu";
import { ensureMonacoEnvironment } from "./monacoEnv";
import { languageForPath } from "./language";
import { editorThemeForApp, ensureEditorThemes } from "./theme";
import { resolvedTheme } from "../../stores/theme";

ensureMonacoEnvironment();
ensureEditorThemes();

export interface MonacoEditorProps {
  /** Current text content. Reactive — pushing a new value updates the
   *  editor without remounting. User edits fire `onChange`. */
  value: string;
  /** Monaco language id (e.g. "typescript", "rust", "plaintext"). Wins
   *  over `path`-based detection when both are provided. */
  language?: string;
  /** File path or name — used to infer the language when `language` is
   *  not set (T13.7). Either absolute or workspace-relative is fine. */
  path?: string;
  /** Editor theme. Defaults to the app theme via `ws-dark` / `ws-light`
   *  registered by `ensureEditorThemes` (T13.7). Override only when a
   *  caller needs a Monaco built-in (e.g. "vs", "hc-black"). */
  theme?: string;
  readOnly?: boolean;
  /** Optional class for the host wrapper. */
  class?: string;
  /** Fires when the editor's content changes from user input. */
  onChange?: (value: string) => void;
}

export function MonacoEditor(props: MonacoEditorProps): JSX.Element {
  let hostEl!: HTMLDivElement;
  let editor: monaco.editor.IStandaloneCodeEditor | null = null;
  let model: monaco.editor.ITextModel | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let suppressOnChange = false;

  // Effective language: explicit prop wins, otherwise infer from `path`.
  const effectiveLanguage = createMemo(() => props.language ?? languageForPath(props.path));
  // Effective theme: explicit prop wins, otherwise follow the app theme so a
  // light/dark toggle swaps the editor without remounting.
  const effectiveTheme = createMemo(() => props.theme ?? editorThemeForApp(resolvedTheme()));

  onMount(() => {
    const initialValue = props.value ?? "";
    const initialLanguage = effectiveLanguage();
    model = monaco.editor.createModel(initialValue, initialLanguage);

    const monoFont = getComputedStyle(hostEl).getPropertyValue("--font-mono").trim();
    editor = monaco.editor.create(hostEl, {
      model,
      theme: effectiveTheme(),
      readOnly: props.readOnly === true,
      automaticLayout: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: monoFont || undefined,
    });

    const liveEditor = editor;
    const sub = liveEditor.onDidChangeModelContent(() => {
      if (suppressOnChange) return;
      props.onChange?.(liveEditor.getValue());
    });

    resizeObserver = new ResizeObserver(() => {
      editor?.layout();
    });
    resizeObserver.observe(hostEl);

    // T13.8: Cmd+F on macOS is the "Find in Pane" menu accelerator (see
    // src-tauri/src/menu/mod.rs), which the OS captures before any keydown
    // listener — Monaco's built-in `actions.find` keybinding never fires.
    // Bridging the menu action back to Monaco when the editor owns DOM
    // focus restores the expected behavior; the same path also serves the
    // Windows hamburger menu's "Find in pane" click. Replace mode reaches
    // Monaco unimpeded (Ctrl+H on Win/Linux, Cmd+Alt+F on macOS) so it
    // doesn't need this bridge.
    const disposeMenu = addMenuActionListener((id) => {
      if (id !== "find-in-pane") return;
      if (!hostEl.contains(document.activeElement)) return;
      liveEditor.getAction("actions.find")?.run();
    });

    onCleanup(() => {
      sub.dispose();
      disposeMenu();
      resizeObserver?.disconnect();
      resizeObserver = null;
      editor?.dispose();
      editor = null;
      model?.dispose();
      model = null;
    });
  });

  createEffect(
    on(
      () => props.value,
      (next) => {
        if (!editor || !model) return;
        const current = editor.getValue();
        if (current === (next ?? "")) return;
        suppressOnChange = true;
        try {
          model.setValue(next ?? "");
        } finally {
          suppressOnChange = false;
        }
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      effectiveLanguage,
      (lang) => {
        if (model && lang) {
          monaco.editor.setModelLanguage(model, lang);
        }
      },
      { defer: true },
    ),
  );

  // `setTheme` is global to monaco — switching it here updates every live
  // editor instance, which is what we want when the app theme toggles.
  createEffect(
    on(
      effectiveTheme,
      (theme) => {
        if (theme) monaco.editor.setTheme(theme);
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => props.readOnly,
      (ro) => {
        editor?.updateOptions({ readOnly: ro === true });
      },
      { defer: true },
    ),
  );

  return (
    <div
      ref={hostEl}
      class={props.class}
      style={{ width: "100%", height: "100%", "min-height": "0" }}
    />
  );
}

export default MonacoEditor;
