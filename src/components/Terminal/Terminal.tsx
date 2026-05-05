import { createEffect, onCleanup, onMount } from "solid-js";
import { Terminal as Xterm, type IDisposable, type ITheme } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { logger } from "../../utils/logger";
import { ptySubscribe, ptyWrite, type PtySubscription } from "../../ipc/pty";

export interface TerminalProps {
  sessionId: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  cursorBlink?: boolean;
  theme?: ITheme;
  /** When false, the terminal does not subscribe to backend PTY output —
   *  used by stress / mount-cycle harnesses that pass synthetic ids. */
  autoSubscribe?: boolean;
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
  // T4.4: streaming UTF-8 decoder. `fatal: false` keeps malformed bytes from
  // throwing (the shell stays usable), and `stream: true` on each `decode`
  // call buffers any bytes belonging to a codepoint that was split across
  // PTY frames so the next frame completes it instead of rendering "�".
  let decoder: TextDecoder | null = null;
  let subscription: PtySubscription | null = null;
  let subscriptionToken = 0;
  // T4.5: xterm input listeners forward keystrokes (and rare binary mouse
  // reports) to the PTY's stdin. The disposables are released on unmount;
  // session-id swaps are handled by reading `currentSessionId` inside the
  // listeners rather than re-attaching, so a key event in flight when the
  // id changes lands on the new session — matching the stop/start
  // semantics of the output subscription above.
  const encoder = new TextEncoder();
  let inputDisposables: IDisposable[] = [];
  // Synced from `props.sessionId` inside the createEffect below so input
  // listeners can read the live id without re-attaching when it changes.
  let currentSessionId = "";

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

  const startSubscription = (sessionId: string): void => {
    if (props.autoSubscribe === false) return;
    if (!term) return;
    const t = term;
    decoder = new TextDecoder("utf-8", { fatal: false });
    const token = ++subscriptionToken;
    void ptySubscribe(sessionId, (chunk) => {
      // Effect-driven re-subscription can race with an in-flight invoke
      // resolving — guard with a token so a stale handler can't leak a
      // chunk into the new session.
      if (token !== subscriptionToken || !decoder) return;
      const text = decoder.decode(chunk, { stream: true });
      if (text.length > 0) t.write(text);
    })
      .then((sub) => {
        if (token !== subscriptionToken) {
          sub.unsubscribe();
          return;
        }
        subscription = sub;
      })
      .catch((error: unknown) => {
        logger.warn("pty_subscribe failed", {
          scope: "terminal",
          sessionId,
          error,
        });
      });
  };

  const stopSubscription = (): void => {
    subscriptionToken += 1;
    subscription?.unsubscribe();
    subscription = null;
    if (decoder) {
      // Flush any buffered partial codepoint so the next session starts
      // with a clean decoder. The trailing bytes are discarded — the new
      // session's stream is independent.
      decoder.decode();
      decoder = null;
    }
  };

  const sendInput = (bytes: Uint8Array): void => {
    if (bytes.byteLength === 0) return;
    const targetId = currentSessionId;
    void ptyWrite(targetId, bytes).catch((error: unknown) => {
      logger.warn("pty_write failed", {
        scope: "terminal",
        sessionId: targetId,
        error,
      });
    });
  };

  // xterm `onBinary` delivers a JS string where each char's low byte is one
  // raw byte of input (e.g. mouse reports that aren't valid UTF-8). We map
  // it back to bytes 1:1 — TextEncoder would re-encode bytes >= 0x80 as
  // multibyte UTF-8 and corrupt the report.
  const binaryStringToBytes = (data: string): Uint8Array => {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
    return bytes;
  };

  const startInputForwarding = (t: Xterm): void => {
    if (props.autoSubscribe === false) return;
    inputDisposables.push(t.onData((data) => sendInput(encoder.encode(data))));
    inputDisposables.push(t.onBinary((data) => sendInput(binaryStringToBytes(data))));
  };

  const stopInputForwarding = (): void => {
    for (const d of inputDisposables) d.dispose();
    inputDisposables = [];
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

    startSubscription(props.sessionId);
    startInputForwarding(term);
  });

  createEffect((prev: string | undefined) => {
    const id = props.sessionId;
    currentSessionId = id;
    if (term && hostEl) hostEl.dataset.sessionId = id;
    if (prev !== undefined && prev !== id) {
      stopSubscription();
      term?.reset();
      startSubscription(id);
    }
    return id;
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
    stopInputForwarding();
    stopSubscription();
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
