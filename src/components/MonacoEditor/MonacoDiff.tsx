// T13.5: Monaco diff editor — side-by-side view used by the editor
// conflict UX when the user picks "View Diff" on an external-change
// banner.
//
// We deliberately keep this a separate component from MonacoEditor
// rather than overloading it with a diff mode. The diff editor wraps
// two models and exposes a different API (`createDiffEditor` vs.
// `create`); folding both into one binding would require mode-aware
// branches in every effect, which would muddy the much hotter
// single-editor path. Lifecycle, layout, and theme handling here
// mirror MonacoEditor.tsx so behaviour stays consistent across the
// two surfaces.

import { createEffect, createMemo, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import * as monaco from "monaco-editor";
import { ensureMonacoEnvironment } from "./monacoEnv";
import { languageForPath } from "./language";
import { editorThemeForApp, ensureEditorThemes } from "./theme";
import { resolvedTheme } from "../../stores/theme";

ensureMonacoEnvironment();
ensureEditorThemes();

export interface MonacoDiffProps {
  /** Left side ("on disk"). Read-only. */
  original: string;
  /** Right side ("your buffer"). Read-only — the conflict UX wants the
   *  user to *decide* between the two sides, not three-way merge. */
  modified: string;
  /** Used for language inference; same rules as MonacoEditor.path. */
  path?: string;
  /** Override the inferred Monaco language id. */
  language?: string;
  /** Override the resolved app theme. */
  theme?: string;
  class?: string;
}

export function MonacoDiff(props: MonacoDiffProps): JSX.Element {
  let hostEl!: HTMLDivElement;
  let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
  let originalModel: monaco.editor.ITextModel | null = null;
  let modifiedModel: monaco.editor.ITextModel | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const effectiveLanguage = createMemo(() => props.language ?? languageForPath(props.path));
  const effectiveTheme = createMemo(() => props.theme ?? editorThemeForApp(resolvedTheme()));

  onMount(() => {
    const lang = effectiveLanguage();
    originalModel = monaco.editor.createModel(props.original ?? "", lang);
    modifiedModel = monaco.editor.createModel(props.modified ?? "", lang);

    const monoFont = getComputedStyle(hostEl).getPropertyValue("--font-mono").trim();
    diffEditor = monaco.editor.createDiffEditor(hostEl, {
      theme: effectiveTheme(),
      readOnly: true,
      // Side-by-side is the more legible choice for code reviews; the
      // inline mode hides the left margin's line numbers, which makes
      // it harder to point at specific changed regions when discussing
      // the conflict.
      renderSideBySide: true,
      automaticLayout: false,
      enableSplitViewResizing: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: monoFont || undefined,
    });
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });

    resizeObserver = new ResizeObserver(() => {
      diffEditor?.layout();
    });
    resizeObserver.observe(hostEl);

    onCleanup(() => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      diffEditor?.dispose();
      diffEditor = null;
      originalModel?.dispose();
      modifiedModel?.dispose();
      originalModel = null;
      modifiedModel = null;
    });
  });

  // Push prop updates into the live models without rebuilding the diff
  // editor; rebuilding would lose the user's scroll position and the
  // momentary flicker is visible at 60Hz.
  createEffect(
    on(
      () => props.original,
      (next) => {
        if (originalModel && originalModel.getValue() !== (next ?? "")) {
          originalModel.setValue(next ?? "");
        }
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => props.modified,
      (next) => {
        if (modifiedModel && modifiedModel.getValue() !== (next ?? "")) {
          modifiedModel.setValue(next ?? "");
        }
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      effectiveLanguage,
      (lang) => {
        if (lang) {
          if (originalModel) monaco.editor.setModelLanguage(originalModel, lang);
          if (modifiedModel) monaco.editor.setModelLanguage(modifiedModel, lang);
        }
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      effectiveTheme,
      (theme) => {
        if (theme) monaco.editor.setTheme(theme);
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

export default MonacoDiff;
