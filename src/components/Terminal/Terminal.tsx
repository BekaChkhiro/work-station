import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Terminal as Xterm, type IDisposable, type ITheme } from "@xterm/xterm";
import { resolvedTheme } from "../../stores/theme";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TerminalSearch } from "./TerminalSearch";
import { logger } from "../../utils/logger";
import {
  ptyGetScrollback,
  ptyResize,
  ptySubscribe,
  ptyWrite,
  type PtySubscription,
} from "../../ipc/pty";

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
  let fitAddon: FitAddon | null = null;
  let searchAddon: SearchAddon | null = null;
  let webLinksAddon: WebLinksAddon | null = null;
  const [searchOpen, setSearchOpen] = createSignal(false);
  let resizeObserver: ResizeObserver | null = null;
  // T4.6: rAF-coalesced resize. ResizeObserver can fire many times within
  // a single frame during drags; we collapse them to one fit() per frame
  // and skip redundant pty_resize invokes by tracking the last cols/rows.
  let resizeFrame = 0;
  let lastCols = 0;
  let lastRows = 0;
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
    void replayThenSubscribe(t, sessionId, token).catch((error: unknown) => {
      logger.warn("pty replay/subscribe failed", {
        scope: "terminal",
        sessionId,
        error,
      });
    });
  };

  // T4.7: Replay scrollback before attaching the live subscription so prior
  // output is restored on mount / tab switch. Live subscription only delivers
  // frames pushed AFTER subscribe attaches, so subscribing *after* the
  // snapshot avoids double-rendering the historical bytes — at the cost of
  // a tiny gap window if the PTY is producing during the round-trip. For
  // tab-switch use cases the PTY is typically idle, making the gap a
  // non-issue in practice.
  //
  // The subscription token is the sequence-number guard called out in the
  // task spec: it short-circuits both the snapshot write and the subscribe
  // attach when a session-id swap arrives mid-replay, so a stale snapshot
  // can't leak into the new session's terminal.
  const replayThenSubscribe = async (t: Xterm, sessionId: string, token: number): Promise<void> => {
    const snapshot = await ptyGetScrollback(sessionId);
    if (token !== subscriptionToken || !decoder) return;
    if (snapshot.data.byteLength > 0) {
      const text = decoder.decode(snapshot.data, { stream: true });
      if (text.length > 0) t.write(text);
    }

    const sub = await ptySubscribe(sessionId, (chunk) => {
      if (token !== subscriptionToken || !decoder) return;
      const text = decoder.decode(chunk, { stream: true });
      if (text.length > 0) t.write(text);
    });

    if (token !== subscriptionToken) {
      sub.unsubscribe();
      return;
    }
    subscription = sub;
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

  // T4.9: Copy / paste. Cmd/Ctrl+C copies the current selection to the
  // clipboard and suppresses the keystroke so xterm doesn't also send ETX
  // (SIGINT). With no selection we let the event through so Ctrl+C still
  // interrupts the foreground process. Cmd/Ctrl+V reads the clipboard and
  // routes through `term.paste(...)`, which emits the bracketed-paste
  // sequences (ESC[200~ … ESC[201~) when the app has enabled DECSET 2004 —
  // shells and editors like fish / nvim depend on those markers to detect
  // pasted input.
  // T4.10: Cmd/Ctrl+F opens the search overlay. Handled before copy/paste so
  // the keystroke is consumed regardless of selection state and never reaches
  // the shell as ^F. F3 / Shift+F3 navigation is wired inside the overlay
  // input — when the overlay is open it owns focus, so xterm's key handler
  // never sees those keys.
  const handleSearchHotkey = (event: KeyboardEvent): boolean => {
    if (event.type !== "keydown") return true;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey) return true;
    if (event.key.toLowerCase() !== "f") return true;
    event.preventDefault();
    setSearchOpen(true);
    return false;
  };

  const closeSearch = (): void => {
    setSearchOpen(false);
    searchAddon?.clearDecorations();
    term?.focus();
  };

  // T4.11: Cmd/Ctrl+click follows the link via the OS default browser (the
  // Tauri opener plugin), instead of `window.open` which would either be
  // blocked or load the URL inside the embedded webview. The modifier-key
  // gate matches VS Code / iTerm2 conventions and prevents accidental
  // navigation from a stray click while the user is selecting text.
  const handleWebLinkClick = (event: MouseEvent, uri: string): void => {
    if (!event.metaKey && !event.ctrlKey) return;
    void openUrl(uri).catch((error: unknown) => {
      logger.warn("openUrl failed", {
        scope: "terminal",
        sessionId: currentSessionId,
        uri,
        error,
      });
    });
  };

  const handleCopyPasteKey = (event: KeyboardEvent): boolean => {
    if (event.type !== "keydown") return true;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey) return true;
    const key = event.key.toLowerCase();
    if (key === "c") {
      if (!term?.hasSelection()) return true;
      const text = term.getSelection();
      if (!text) return true;
      void navigator.clipboard.writeText(text).catch((error: unknown) => {
        logger.warn("clipboard copy failed", {
          scope: "terminal",
          sessionId: currentSessionId,
          error,
        });
      });
      return false;
    }
    if (key === "v") {
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text && term) term.paste(text);
        })
        .catch((error: unknown) => {
          logger.warn("clipboard paste failed", {
            scope: "terminal",
            sessionId: currentSessionId,
            error,
          });
        });
      return false;
    }
    return true;
  };

  // T4.6: Compute the cell grid that fits the host element and forward it
  // to xterm + the backend PTY. Skips when dimensions haven't actually
  // changed so a flurry of ResizeObserver callbacks (drag handles, layout
  // settling) collapses to at most one pty_resize per real change.
  const applyFit = (): void => {
    if (!term || !fitAddon || !hostEl) return;
    if (hostEl.clientWidth === 0 || hostEl.clientHeight === 0) return;
    const dims = fitAddon.proposeDimensions();
    if (!dims) return;
    const { cols, rows } = dims;
    if (cols <= 0 || rows <= 0) return;
    if (cols === lastCols && rows === lastRows) return;
    fitAddon.fit();
    lastCols = cols;
    lastRows = rows;
    if (props.autoSubscribe === false) return;
    const targetId = currentSessionId;
    if (!targetId) return;
    void ptyResize(targetId, cols, rows).catch((error: unknown) => {
      logger.warn("pty_resize failed", {
        scope: "terminal",
        sessionId: targetId,
        cols,
        rows,
        error,
      });
    });
  };

  const scheduleFit = (): void => {
    if (resizeFrame !== 0) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      applyFit();
    });
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

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);

    webLinksAddon = new WebLinksAddon(handleWebLinkClick);
    term.loadAddon(webLinksAddon);

    term.open(hostEl);
    hostEl.dataset.sessionId = props.sessionId;

    // WebGL addon must be loaded after term.open() — it requires the DOM.
    enableWebgl(term);

    term.attachCustomKeyEventHandler((event) => {
      if (!handleSearchHotkey(event)) return false;
      return handleCopyPasteKey(event);
    });

    startSubscription(props.sessionId);
    startInputForwarding(term);

    // Initial fit synchronously so the first frame matches the host size,
    // then watch for any subsequent dimension changes via ResizeObserver.
    // Hosts mounted into a hidden tab may have zero size on mount — the
    // observer will still fire once they become visible.
    applyFit();
    resizeObserver = new ResizeObserver(() => scheduleFit());
    resizeObserver.observe(hostEl);
  });

  createEffect((prev: string | undefined) => {
    const id = props.sessionId;
    currentSessionId = id;
    if (term && hostEl) hostEl.dataset.sessionId = id;
    if (prev !== undefined && prev !== id) {
      stopSubscription();
      term?.reset();
      // Force the next applyFit to re-send dimensions — the new PTY may
      // have been spawned at a different size, and we don't want our
      // cached cols/rows to suppress the corrective pty_resize.
      lastCols = 0;
      lastRows = 0;
      startSubscription(id);
      applyFit();
    }
    return id;
  });

  createEffect(() => {
    const t = props.theme;
    if (term && t) term.options.theme = t;
  });

  createEffect(() => {
    const family = props.fontFamily;
    if (term && family) {
      term.options.fontFamily = family;
      scheduleFit();
    }
  });

  createEffect(() => {
    const size = props.fontSize;
    if (term && size) {
      term.options.fontSize = size;
      scheduleFit();
    }
  });

  createEffect(() => {
    const lh = props.lineHeight;
    if (term && lh) {
      term.options.lineHeight = lh;
      scheduleFit();
    }
  });

  createEffect(() => {
    const blink = props.cursorBlink;
    if (term && typeof blink === "boolean") term.options.cursorBlink = blink;
  });

  // T4.8: Re-read CSS vars whenever the resolved theme changes so xterm picks
  // up the new palette without a remount. Only applies when the caller hasn't
  // pinned a theme via props.theme.
  createEffect(() => {
    resolvedTheme(); // track
    if (term && !props.theme) term.options.theme = themeFromTokens(hostEl);
  });

  onCleanup(() => {
    stopInputForwarding();
    stopSubscription();
    if (resizeFrame !== 0) {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = 0;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    fitAddon?.dispose();
    fitAddon = null;
    searchAddon?.dispose();
    searchAddon = null;
    webLinksAddon?.dispose();
    webLinksAddon = null;
    webglAddon?.dispose();
    unicodeAddon?.dispose();
    term?.dispose();
    webglAddon = null;
    unicodeAddon = null;
    term = null;
    lastCols = 0;
    lastRows = 0;
    webglRecoveryAttempted = false;
  });

  return (
    <div class="ws-terminal-frame relative h-full w-full">
      <div
        ref={hostEl}
        class="ws-terminal h-full w-full bg-terminal text-fg-terminal font-mono"
        data-session-id={props.sessionId}
      />
      <Show when={searchOpen() ? searchAddon : null}>
        {(addon) => <TerminalSearch addon={addon()} onClose={closeSearch} />}
      </Show>
    </div>
  );
}

export default Terminal;
