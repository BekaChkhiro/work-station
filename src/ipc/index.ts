// Frontend IPC bindings: typed wrappers around Tauri `invoke` and event channels.
// Implementations land alongside the first command-using feature.
export { cliListAvailable } from "./cli";
export type { CliInfo } from "./cli";
export { pickProjectFolder } from "./picker";
export { ptySpawn, ptySubscribe, ptyWrite } from "./pty";
export type {
  PtyChunkHandler,
  PtySpawnArgs,
  PtySpawnResponse,
  PtySubscription,
  PtyWriteArgs,
} from "./pty";
