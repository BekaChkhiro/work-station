import { createSignal, createResource } from "solid-js";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

const [status, setStatus] = createSignal<UpdateStatus>("idle");
const [updateInfo, setUpdateInfo] = createSignal<Update | null>(null);
const [downloadProgress, setDownloadProgress] = createSignal(0);
const [error, setError] = createSignal<string | null>(null);

export { status, updateInfo, downloadProgress, error };

/**
 * Check for updates from the configured endpoint.
 * Safe to call multiple times — debounced by the plugin itself.
 */
export async function checkForUpdate(): Promise<Update | null> {
  setStatus("checking");
  setError(null);

  try {
    const update = await check();
    if (update) {
      setUpdateInfo(update);
      setStatus("available");
      return update;
    }
    setStatus("idle");
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    setStatus("error");
    console.error("[updater] check failed:", msg);
    return null;
  }
}

/**
 * Download the available update and install it on next restart.
 */
export async function downloadAndInstall(): Promise<void> {
  const update = updateInfo();
  if (!update) return;

  setStatus("downloading");
  setDownloadProgress(0);

  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          setDownloadProgress(0);
          break;
        case "Progress":
          // event.data is bytes transferred in this chunk; we don't get total
          // so we just pulse a rough indicator.
          setDownloadProgress((p) => Math.min(p + 5, 95));
          break;
        case "Finished":
          setDownloadProgress(100);
          break;
      }
    });

    setStatus("ready");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    setStatus("error");
    console.error("[updater] download failed:", msg);
  }
}

/**
 * Dismiss the current update notification.
 */
export function dismissUpdate(): void {
  setUpdateInfo(null);
  setStatus("idle");
  setError(null);
  setDownloadProgress(0);
}

/**
 * Convenience resource: auto-check once on mount.
 */
export function createUpdateCheckResource() {
  return createResource(async () => checkForUpdate());
}
