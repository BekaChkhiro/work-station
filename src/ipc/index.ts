// Frontend IPC bindings: typed wrappers around Tauri `invoke` and event channels.
// Implementations land alongside the first command-using feature.
export { pickProjectFolder } from "./picker";
export { ptySpawn, ptySubscribe } from "./pty";
export type { PtyChunkHandler, PtySpawnArgs, PtySpawnResponse, PtySubscription } from "./pty";
