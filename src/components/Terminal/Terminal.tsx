import { createEffect, onCleanup, onMount } from "solid-js";
import { Terminal as Xterm, type ITheme } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { logger } from "../../utils/logger";

export interface TerminalProps {
  sessionId: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  cursorBlink?: boolean;
  theme?: ITheme;
}

export type TerminalRenderer = "webgl" | "dom";

const DEFAULT_FONT_SIZE = 13;
const DEFAULT_LINE_HEIGHT = 1.4;

const readCssVar = (host: HTMLElement, name: string): string =>
  getComputedStyle(host).getPropertyValue(name).trim();

const themeFromTokens = (host: HTMLElement): ITheme => ({
  background: readCssVar(host, "--bg-terminal") || "#0b0c0e",
  foreground: readCssVar(host, "--text-terminal") || "#d6d3c9",
  cursor: readCssVar(host, "--accent") || "#a0d8d8",
  cursorAccent: readCssVar(host, "--bg-terminal") || "#0b0c0e",
  selectionBackground: readCssVar(host, "--accent-soft") || "rgba(160,216,216,0.2)",
});

const fontFromTokens = (host: HTMLElement): string =>
  readCssVar(host, "--font-mono") || "ui-monospace, monospace";

export function Terminal(props: TerminalProps) {
  let hostEl!: HTMLDivElement;
  let term: Xterm | null = null;
  let unicodeAddon: Unicode11Addon | null = null;
  let webglAddon: WebglAddon | null = null;
  let webglRecoveryAttempted = false;

  const setRendererAttr = (mode: TerminalRenderer) => {
    if (hostEl) hostEl.dataset.renderer = mode;
  };

  const enableWebgl = (t: Xterm): void => {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => handleContextLoss(t, addon));
      t.loadAddon(addon);
      webglAddon = addon;
      setRendererAttr("webgl");
    } catch (error) {
      logger.warn("xterm WebGL renderer unavailable; using DOM renderer", {
        scope: "terminal",
        sessionId: props.sessionId,
        error,
      });
      setRendererAttr("dom");
    }
  };

  const handleContextLoss = (t: Xterm, lost: WebglAddon): void => {
    logger.warn("xterm WebGL context lost; falling back to DOM renderer", {
      scope: "terminal",
      sessionId: props.sessionId,
    });

    if (!webglRecoveryAttempted && hostEl) {
      webglRecoveryAttempted = true;
      // Capture canvases BEFORE dispose removes them so the restored event
      // can still trigger our single recovery attempt.
      const canvases = Array.from(hostEl.querySelectorAll("canvas"));
      for (const canvas of canvases) {
        canvas.addEventListener("webglcontextrestored", () => recoverWebgl(t), {
          once: true,
        });
      }
    }

    lost.dispose();
    if (webglAddon === lost) webglAddon = null;
    setRendererAttr("dom");
  };

  const recoverWebgl = (t: Xterm): void => {
    if (webglAddon || !term) return;
    try {
      // Single recovery — do not resubscribe to onContextLoss. If the new
      // context also fails, we stay on DOM rather than thrash.
      const restored = new WebglAddon();
      t.loadAddon(restored);
      webglAddon = restored;
      setRendererAttr("webgl");
      logger.info("xterm WebGL context restored", {
        scope: "terminal",
        sessionId: props.sessionId,
      });
    } catch (error) {
      logger.warn("xterm WebGL recovery failed; remaining on DOM renderer", {
        scope: "terminal",
        sessionId: props.sessionId,
        error,
      });
    }
  };

  onMount(() => {
    const theme = props.theme ?? themeFromTokens(hostEl);
    const fontFamily = props.fontFamily ?? fontFromTokens(hostEl);

    term = new Xterm({
      allowProposedApi: true,
      fontFamily,
      fontSize: props.fontSize ?? DEFAULT_FONT_SIZE,
      lineHeight: props.lineHeight ?? DEFAULT_LINE_HEIGHT,
      cursorBlink: props.cursorBlink ?? true,
      theme,
      scrollback: 10_000,
      convertEol: false,
    });

    unicodeAddon = new Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = "11";

    term.open(hostEl);
    hostEl.dataset.sessionId = props.sessionId;

    // WebGL addon must be loaded after term.open() — it requires the DOM.
    enableWebgl(term);
  });

  createEffect(() => {
    const id = props.sessionId;
    if (term && hostEl) hostEl.dataset.sessionId = id;
  });

  createEffect(() => {
    const t = props.theme;
    if (term && t) term.options.theme = t;
  });

  createEffect(() => {
    const family = props.fontFamily;
    if (term && family) term.options.fontFamily = family;
  });

  createEffect(() => {
    const size = props.fontSize;
    if (term && size) term.options.fontSize = size;
  });

  createEffect(() => {
    const lh = props.lineHeight;
    if (term && lh) term.options.lineHeight = lh;
  });

  createEffect(() => {
    const blink = props.cursorBlink;
    if (term && typeof blink === "boolean") term.options.cursorBlink = blink;
  });

  onCleanup(() => {
    webglAddon?.dispose();
    unicodeAddon?.dispose();
    term?.dispose();
    webglAddon = null;
    unicodeAddon = null;
    term = null;
    webglRecoveryAttempted = false;
  });

  return (
    <div
      ref={hostEl}
      class="ws-terminal h-full w-full bg-terminal text-fg-terminal font-mono"
      data-session-id={props.sessionId}
    />
  );
}

export default Terminal;
