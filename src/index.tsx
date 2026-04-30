/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { enableHotkeys, loadHotkeysFromDb } from "./stores/hotkey";
import { registerDefaultHandlers } from "./stores/hotkey-handlers";
import { loadThemeFromDb } from "./stores/theme";
import "./styles/index.css";

// Initialise hotkey registry and enable global listener.
void (async () => {
  await loadHotkeysFromDb();
  registerDefaultHandlers();
  enableHotkeys();
})();

// Load theme preference from SQLite (falls back to localStorage).
void loadThemeFromDb();

render(() => <App />, document.getElementById("root") as HTMLElement);
