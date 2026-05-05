import { createEffect, onCleanup, onMount } from "solid-js";
import { Terminal as Xterm, type ITheme } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

export interface TerminalProps {
  sessionId: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  cursorBlink?: boolean;
  theme?: ITheme;
}

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
    unicodeAddon?.dispose();
    term?.dispose();
    unicodeAddon = null;
    term = null;
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
