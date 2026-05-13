import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { WsBridgeClosedError, WsBridgeServerError } from "../../lib/wsBridge";
import { bridgeLastError, bridgeState, getBridge } from "../../stores/wsBridge";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  /** Shell to spawn. Defaults to bash on the server side. */
  command?: string;
  /** Optional cwd for the PTY session. */
  cwd?: string;
}

const DEFAULT_COMMAND = "/bin/bash";

export function Terminal(props: TerminalProps) {
  let host!: HTMLDivElement;
  const [phase, setPhase] = createSignal<"connecting" | "ready" | "error" | "closed">("connecting");
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

  onMount(() => {
    const bridge = getBridge();
    if (!bridge) {
      setPhase("error");
      setErrorMessage("No connection configured. Set the WebSocket URL and token first.");
      return;
    }

    const xterm = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5_000,
      convertEol: true,
      allowProposedApi: true,
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e7eb",
        cursor: "#22d3ee",
        cursorAccent: "#0a0a0a",
        selectionBackground: "rgba(34, 211, 238, 0.35)",
      },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(new WebLinksAddon());
    xterm.open(host);

    // Initial sizing must run after open(); rAF gives layout one frame to settle.
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        // fit can throw if the container is detached during the first frame.
      }
    });

    let sessionId: string | null = null;
    let disposed = false;

    const offOutput = bridge.onPtyOutput((bytes, sid) => {
      if (sid === sessionId) xterm.write(bytes);
    });

    const offExit = bridge.onPtyExit((sid) => {
      if (sid === sessionId) {
        xterm.writeln("\r\n\x1b[2;37m[process exited]\x1b[0m");
        setPhase("closed");
      }
    });

    const onKey = xterm.onData((data) => {
      if (!sessionId) return;
      bridge.ptyWrite(sessionId, data).catch((err) => {
        if (!(err instanceof WsBridgeClosedError)) {
          // Surface server-side write rejections without nuking the session.
          xterm.writeln(`\r\n\x1b[31m[write failed: ${describeError(err)}]\x1b[0m`);
        }
      });
    });

    // Resize: debounce via a single rAF coalesce so iOS rotation doesn't
    // hammer the server with intermediate sizes.
    let rafHandle = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      rafHandle = requestAnimationFrame(() => {
        rafHandle = 0;
        try {
          fit.fit();
        } catch {
          return;
        }
        if (sessionId) {
          bridge.ptyResize(sessionId, xterm.cols, xterm.rows).catch(() => {
            // Silently ignore — a transient resize failure shouldn't break the UI.
          });
        }
      });
    });
    resizeObserver.observe(host);

    const spawn = async () => {
      try {
        const { sessionId: sid } = await bridge.ptySpawn({
          command: props.command ?? DEFAULT_COMMAND,
          args: [],
          cwd: props.cwd,
          cols: xterm.cols || 80,
          rows: xterm.rows || 24,
        });
        if (disposed) {
          // Component unmounted during the spawn round-trip — clean up the orphan.
          bridge.ptyKill(sid).catch(() => undefined);
          return;
        }
        sessionId = sid;

        // Replay any pre-existing scrollback (T4.7 parity for mobile). Iterate
        // chunks until we've drained the buffer.
        let offset = 0;
        while (true) {
          const chunk = await bridge.ptyScrollback(sid, offset);
          if (chunk.data.byteLength === 0) break;
          xterm.write(chunk.data);
          if (chunk.nextOffset <= offset) break;
          offset = chunk.nextOffset;
          if (offset >= chunk.totalBytes) break;
        }
        setPhase("ready");
      } catch (err) {
        setPhase("error");
        setErrorMessage(describeError(err));
      }
    };

    void spawn();

    onCleanup(() => {
      disposed = true;
      if (rafHandle) cancelAnimationFrame(rafHandle);
      resizeObserver.disconnect();
      offOutput();
      offExit();
      onKey.dispose();
      if (sessionId) {
        bridge.ptyKill(sessionId).catch(() => undefined);
      }
      xterm.dispose();
    });
  });

  return (
    <div class="relative flex h-full w-full flex-col">
      <Show when={phase() !== "ready"}>
        <div class="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900/80 px-3 py-1.5 text-xs">
          <Show when={phase() === "connecting"}>
            <span class="size-1.5 rounded-full bg-amber-400" aria-hidden="true" />
            <span class="text-neutral-300">Starting session…</span>
            <span class="ml-auto text-neutral-500">{bridgeState()}</span>
          </Show>
          <Show when={phase() === "error"}>
            <span class="size-1.5 rounded-full bg-red-500" aria-hidden="true" />
            <span class="text-red-300">{errorMessage() ?? "Failed to start"}</span>
          </Show>
          <Show when={phase() === "closed"}>
            <span class="size-1.5 rounded-full bg-neutral-500" aria-hidden="true" />
            <span class="text-neutral-300">Process exited</span>
          </Show>
        </div>
      </Show>
      <div ref={host} class="min-h-0 flex-1 bg-neutral-950" />
      <Show when={bridgeState() !== "open" && phase() === "ready"}>
        <div class="absolute right-2 top-2 rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-200">
          {bridgeState()}
        </div>
      </Show>
      <Show when={bridgeLastError()}>
        <div class="border-t border-neutral-800 bg-neutral-900 px-3 py-1 text-[10px] text-red-300">
          {bridgeLastError()}
        </div>
      </Show>
    </div>
  );
}

function describeError(err: unknown): string {
  if (err instanceof WsBridgeServerError) return `${err.kind}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
