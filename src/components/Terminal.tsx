import { onCleanup, onMount, untrack } from "solid-js";
import { Terminal as XTermTerminal, type ITerminalOptions, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { ptyResize } from "../ipc";
import "@xterm/xterm/css/xterm.css";

export interface TerminalProps {
  /** Session UUID that this terminal pane is bound to. */
  sessionId: string;
}

/**
 * Resolve a CSS custom property to its computed color value.
 *
 * xterm.js canvas/WebGL renderers need actual hex/rgb strings,
 * so we read the value from the document root at mount time.
 */
function resolveToken(token: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || "#000000";
}

/**
 * Solid wrapper around xterm.js.
 *
 * Mounts a Terminal instance on a `<div ref>` and disposes it on unmount.
 * Uses WebGL renderer by default with automatic canvas fallback on context loss.
 * Later tasks wire up PTY I/O (T4.4/T4.5), resize (T4.6),
 * scrollback replay (T4.7), theme reactivity (T4.8), etc.
 */
export default function Terminal(props: TerminalProps) {

  // eslint-disable-next-line prefer-const
  let containerRef: HTMLDivElement | undefined = undefined;
  let term: XTermTerminal | undefined = undefined;
  let fitAddon: FitAddon | undefined = undefined;
  let webglAddon: WebglAddon | undefined = undefined;
  let contextLossDisposer: IDisposable | undefined = undefined;
  let resizeObserver: ResizeObserver | undefined = undefined;
  let resizeTimeout: ReturnType<typeof setTimeout> | undefined = undefined;

  onMount(() => {
    if (!containerRef) return;

    const options: ITerminalOptions = {
      fontFamily: resolveToken("--font-mono"),
      fontSize: 14,
      cursorBlink: true,
      cursorStyle: "block",
      theme: {
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
      },
    };

    term = new XTermTerminal(options);
    term.open(containerRef);

    // Load FitAddon for automatic dimension calculation
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Initial fit to establish correct cols/rows
    fitAddon.fit();

    // Load WebGL addon as default renderer
    try {
      webglAddon = new WebglAddon();
      contextLossDisposer = webglAddon.onContextLoss(() => {
        // Dispose WebGL addon; xterm.js falls back to canvas renderer automatically
        webglAddon?.dispose();
        webglAddon = undefined;
        contextLossDisposer?.dispose();
        contextLossDisposer = undefined;
        console.warn(`[Terminal ${untrack(() => props.sessionId)}] WebGL context lost. Falling back to canvas renderer.`);
      });
      term.loadAddon(webglAddon);
    } catch {
      console.warn(`[Terminal ${untrack(() => props.sessionId)}] WebGL addon failed to load. Using canvas renderer.`);
    }

    // Debounced resize handler: fit then notify backend
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
  });

  onCleanup(() => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeObserver?.disconnect();
    resizeObserver = undefined;
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
