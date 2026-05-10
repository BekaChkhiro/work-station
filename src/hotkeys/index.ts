export { installNumericProjectHotkeys, useNumericProjectHotkeys } from "./numericProjectHotkeys";
export { installPaneHotkeys, usePaneHotkeys } from "./paneHotkeys";
export type { PaneHotkeyDefaultCli, PaneHotkeyHandlers } from "./paneHotkeys";
export { installPaneNavHotkeys, usePaneNavHotkeys } from "./paneNavHotkeys";
export {
  eventMatchesBinding,
  formatBinding,
  getBinding,
  listActions,
  setBinding,
} from "./registry";
export type { Binding, HotkeyAction, Modifier } from "./registry";
