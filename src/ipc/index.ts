// Frontend IPC bindings: typed wrappers around Tauri `invoke`, event
// channels, and (since T19.6) the cloud-agent WebSocket bridge —
// transport selection happens inside each wrapper via
// [`routeIpc`]. Implementations land alongside the first
// command-using feature.
export { cliListAvailable } from "./cli";
export type { CliInfo } from "./cli";
export { readTextFile, writeTextFile } from "./files";
export type { BinaryReason, ReadFileResult, TextEncoding } from "./files";
export { onExternalChange, startFileWatch, stopFileWatch } from "./fileWatch";
export type { ExternalChangeEvent } from "./fileWatch";
export { fsListDir } from "./fs";
export type { FsDirEntry, FsListDirOptions } from "./fs";
export { pickProjectFolder } from "./picker";
export { ptySpawn, ptySubscribe, ptyWrite } from "./pty";
export type {
  PtyChunkHandler,
  PtySpawnArgs,
  PtySpawnResponse,
  PtySubscription,
  PtyWriteArgs,
} from "./pty";
export { subscribeSystemStats } from "./systemStats";
export type { SystemStatsHandler, SystemStatsSubscription } from "./systemStats";
export {
  CloudTransportUnavailableError,
  CloudTransportUnsupportedError,
  currentTransport,
  getCloudAgentManager,
  routeIpc,
  routeIpcLocalOnly,
} from "./transport";
export type { RouteOptions, TransportKind } from "./transport";
