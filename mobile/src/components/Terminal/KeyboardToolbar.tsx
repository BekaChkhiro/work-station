import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { getBridge } from "../../stores/wsBridge";

interface KeyboardToolbarProps {
  sessionId: string;
}

interface ToolbarKey {
  label: string;
  data: string;
  aria: string;
}

const KEYS: ToolbarKey[] = [
  { label: "Ctrl+C", data: "\x03", aria: "Send Ctrl+C (interrupt running process)" },
  { label: "Tab", data: "\t", aria: "Send Tab" },
  { label: "Esc", data: "\x1b", aria: "Send Escape" },
  { label: "↑", data: "\x1b[A", aria: "Up arrow" },
  { label: "↓", data: "\x1b[B", aria: "Down arrow" },
  { label: "←", data: "\x1b[D", aria: "Left arrow" },
  { label: "→", data: "\x1b[C", aria: "Right arrow" },
  { label: "Enter", data: "\r", aria: "Send Enter" },
];

// Threshold below which we treat the visual viewport delta as noise (URL
// bar collapse, momentum scroll) rather than a software keyboard.
const KEYBOARD_MIN_HEIGHT_PX = 120;

export function KeyboardToolbar(props: KeyboardToolbarProps) {
  const [keyboardHeight, setKeyboardHeight] = createSignal(0);
  const [visible, setVisible] = createSignal(false);

  onMount(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    if (!vv) return;

    const update = () => {
      // The keyboard occupies the area between the bottom of the visual
      // viewport and the bottom of the layout viewport.
      const occluded = window.innerHeight - vv.height - vv.offsetTop;
      const kbHeight = Math.max(0, Math.round(occluded));
      setKeyboardHeight(kbHeight);
      setVisible(kbHeight >= KEYBOARD_MIN_HEIGHT_PX);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    onCleanup(() => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    });
  });

  const send = (data: string) => {
    const bridge = getBridge();
    if (!bridge) return;
    bridge.ptyWrite(props.sessionId, data).catch(() => undefined);
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate(10);
      } catch {
        // Vibration API is best-effort; some browsers gate it behind
        // user-activation policies and throw.
      }
    }
  };

  return (
    <Show when={visible()}>
      <div
        class="pointer-events-none fixed inset-x-0 z-30"
        style={{ bottom: `${keyboardHeight()}px` }}
      >
        <div
          role="toolbar"
          aria-label="Terminal keyboard helpers"
          class="pointer-events-auto flex gap-1 overflow-x-auto border-t border-neutral-800 bg-neutral-900/95 px-2 py-1.5 backdrop-blur"
        >
          <For each={KEYS}>
            {(k) => (
              <button
                type="button"
                aria-label={k.aria}
                class="min-h-[36px] min-w-[44px] shrink-0 rounded border border-neutral-700 bg-neutral-950 px-2 font-mono text-xs font-medium text-neutral-100 active:bg-neutral-800"
                onPointerDown={(e) => {
                  // xterm holds focus on a hidden textarea — letting the
                  // button steal focus would dismiss the software
                  // keyboard, which is exactly what this toolbar exists
                  // to avoid.
                  e.preventDefault();
                }}
                onClick={() => send(k.data)}
              >
                {k.label}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
