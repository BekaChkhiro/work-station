import { createEffect, onCleanup, onMount, untrack } from "solid-js";
import { Terminal as XTermTerminal, type ITerminalOptions, type ITheme, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { clipboardReadText, ptyResize, ptyWrite } from "../ipc";
import { theme } from "../stores/theme";
import "@xterm/xterm/css/xterm.css";

export interface TerminalProps {
  /** Session UUID that this terminal pane is bound to. */
  sessionId: string;
}

/**
 * Resolve a CSS custom property to its computed color value.
 *
 * xterm.js canvas/WebGL renderers need actual hex/rgb strings,
 * so we read the value from the document root at call time.
 */
function resolveToken(token: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || "#000000";
}

/** Build an xterm.js ITheme object from the current CSS tokens. */
function buildXtermTheme(): ITheme {
  return {
    background: resolveToken("--surface-base"),
    foreground: resolveToken("--text-primary"),
    cursor: resolveToken("--text-primary"),
    selectionBackground: resolveToken("--surface-active"),
    selectionForeground: resolveToken("--text-primary"),
    black: resolveToken("--color-terminal-black"),
    red: resolveToken("--color-terminal-red"),
    green: resolveToken("--color-terminal-green"),
    yellow: resolveToken("--color-terminal-yellow"),
    blue: resolveToken("--color-terminal-blue"),
    magenta: resolveToken("--color-terminal-magenta"),
    cyan: resolveToken("--color-terminal-cyan"),
    white: resolveToken("--color-terminal-white"),
  };
}

/**
 * Solid wrapper around xterm.js.
 *
 * Mounts a Terminal instance on a `<div ref>` and disposes it on unmount.
 * Uses WebGL renderer by default with automatic canvas fallback on context loss.
 * Pauses rendering (and WebGL) when the terminal is hidden from view
 * (intersection hidden or document backgrounded) to save CPU/GPU.
 * Theme is reactive and updates when the app theme changes (T4.8).
 */
export default function Terminal(props: TerminalProps) {

  // eslint-disable-next-line prefer-const
  let containerRef: HTMLDivElement | undefined = undefined;
  let term: XTermTerminal | undefined = undefined;
  let fitAddon: FitAddon | undefined = undefined;
  let webglAddon: WebglAddon | undefined = undefined;
  let webglFailed = false;
  let contextLossDisposer: IDisposable | undefined = undefined;
  let resizeObserver: ResizeObserver | undefined = undefined;
  let resizeTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
  let intersectionObserver: IntersectionObserver | undefined = undefined;
  let dataDisposer: IDisposable | undefined = undefined;

  // Visibility tracking
  let elementVisible = false;
  let documentVisible = true;
  let isVisible = false;

  function attachWebgl() {
    if (!term || webglAddon || webglFailed) return;
    try {
      webglAddon = new WebglAddon();
      contextLossDisposer = webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = undefined;
        contextLossDisposer?.dispose();
        contextLossDisposer = undefined;
        webglFailed = true;
        console.warn(`[Terminal ${untrack(() => props.sessionId)}] WebGL context lost. Falling back to canvas renderer.`);
      });
      term.loadAddon(webglAddon);
    } catch {
      webglFailed = true;
      console.warn(`[Terminal ${untrack(() => props.sessionId)}] WebGL addon failed to load. Using canvas renderer.`);
    }
  }

  function detachWebgl() {
    contextLossDisposer?.dispose();
    contextLossDisposer = undefined;
    webglAddon?.dispose();
    webglAddon = undefined;
  }

  function startResizeObserver() {
    if (!containerRef || resizeObserver) return;

    const doResize = () => {
      if (!term || !fitAddon) return;
      fitAddon.fit();
      const cols = term.cols;
      const rows = term.rows;
      const sid = untrack(() => props.sessionId);
      ptyResize(sid, cols, rows).catch(() => {
        // Ignore errors for demo / stale sessions
      });
    };

    resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(doResize, 150);
    });
    resizeObserver.observe(containerRef);
  }

  function stopResizeObserver() {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = undefined;
    resizeObserver?.disconnect();
    resizeObserver = undefined;
  }

  function updateVisibility() {
    const shouldBeVisible = elementVisible && documentVisible;
    if (shouldBeVisible === isVisible) return;

    if (shouldBeVisible) {
      isVisible = true;
      attachWebgl();
      startResizeObserver();
      if (term && fitAddon) {
        fitAddon.fit();
        const cols = term.cols;
        const rows = term.rows;
        const sid = untrack(() => props.sessionId);
        ptyResize(sid, cols, rows).catch(() => {
          // Ignore errors for demo / stale sessions
        });
      }
    } else {
      isVisible = false;
      stopResizeObserver();
      detachWebgl();
    }
  }

  function handleIntersection(entries: IntersectionObserverEntry[]) {
    elementVisible = entries[0]?.isIntersecting ?? false;
    updateVisibility();
  }

  function handleVisibilityChange() {
    documentVisible = document.visibilityState === "visible";
    updateVisibility();
  }

  onMount(() => {
    if (!containerRef) return;

    const options: ITerminalOptions = {
      fontFamily: resolveToken("--font-mono"),
      fontSize: 14,
      cursorBlink: true,
      cursorStyle: "block",
      theme: buildXtermTheme(),
    };

    term = new XTermTerminal(options);
    term.open(containerRef);

    // Load FitAddon for automatic dimension calculation
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Initial fit to establish correct cols/rows
    fitAddon.fit();

    // Set up visibility tracking before assuming visibility
    intersectionObserver = new IntersectionObserver(handleIntersection, { threshold: 0 });
    intersectionObserver.observe(containerRef);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Forward keystrokes to the PTY backend (T4.5)
    dataDisposer = term.onData((data: string) => {
      const sid = untrack(() => props.sessionId);
      ptyWrite(sid, new TextEncoder().encode(data)).catch(() => {
        // Ignore errors for demo / stale sessions
      });
    });

    // Copy / paste key handling (T4.9)
    // - Cmd/Ctrl+C with selection → copy to clipboard, do NOT send ^C to PTY
    // - Cmd/Ctrl+V → read clipboard and paste into terminal
    //   term.paste() automatically wraps content in bracketed-paste sequences
    //   when the terminal is in bracketed-paste mode.
    const t = term; // capture narrowed reference for the closure
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;

      const mod = e.metaKey || e.ctrlKey;

      // Copy: prevent xterm.js from sending ^C when text is selected
      if (mod && e.key === "c" && t.hasSelection()) {
        return false;
      }

      // Paste: read from system clipboard and inject into terminal
      if (mod && e.key === "v") {
        e.preventDefault();
        clipboardReadText()
          .then((text) => {
            if (text) t.paste(text);
          })
          .catch((err: unknown) => {
            console.warn(`[Terminal ${untrack(() => props.sessionId)}] Paste failed:`, err);
          });
        return false;
      }

      return true;
    });

    // Assume initially visible; IntersectionObserver will correct us if not.
    elementVisible = true;
    updateVisibility();
  });

  // Reactive theme update — refreshes xterm colors when the app theme changes (T4.8)
  createEffect(() => {
    // Access theme to register dependency
    theme();
    if (!term) return;
    term.options.theme = buildXtermTheme();
  });

  onCleanup(() => {
    dataDisposer?.dispose();
    dataDisposer = undefined;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    intersectionObserver?.disconnect();
    intersectionObserver = undefined;
    stopResizeObserver();
    contextLossDisposer?.dispose();
    contextLossDisposer = undefined;
    webglAddon?.dispose();
    webglAddon = undefined;
    fitAddon = undefined;
    term?.dispose();
    term = undefined;
  });

  return <div ref={containerRef} class="w-full h-full" data-session-id={props.sessionId} />;
}
