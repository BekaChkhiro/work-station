import { onCleanup, onMount } from "solid-js";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import ProjectWorkspace from "./components/ProjectWorkspace";
import { isMac } from "./utils/platform";
import UpdateChecker from "./components/UpdateChecker";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export default function App() {
  onMount(() => {
    let unlisten: UnlistenFn | undefined;

    listen("menu:event", (event) => {
      const action = (event.payload as { action: string }).action;
      switch (action) {
        case "toggle-theme":
          // Handled by hotkey registry (T8.2)
          break;
        case "reload":
          window.location.reload();
          break;
        case "new-terminal":
        case "new-terminal-tab":
        case "close-pane":
        case "new-project":
        case "open-project":
        case "clear-terminal":
        case "zoom-in":
        case "zoom-out":
        case "zoom-reset":
        case "bring-all-front":
        case "help":
        case "check-updates":
        case "preferences":
          // TODO: wire up as corresponding frontend features land
          console.log("[menu] unimplemented action:", action);
          break;
        default:
          console.log("[menu] unknown action:", action);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // Ignore when running outside Tauri (e.g. vite dev in browser).
      });

    onCleanup(() => unlisten?.());
  });

  return (
    <div
      class={`flex flex-col h-screen w-screen overflow-hidden bg-surface-base text-text-primary font-sans ${isMac() ? "pt-[var(--titlebar-height)]" : ""}`}
    >
      <TitleBar />
      <div class="flex flex-1 overflow-hidden">
        {/* Main workspace — tab strip + terminal layout */}
        <ProjectWorkspace />

        {/* Right-side project sidebar */}
        <Sidebar />

        {/* Auto-update notification */}
        <UpdateChecker />
      </div>
    </div>
  );
}
