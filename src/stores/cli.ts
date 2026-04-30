/**
 * CLI detection store.
 *
 * Caches the list of available CLIs detected on the backend at app boot.
 * Populated once via `loadClis()` (usually called on app mount).
 */

import { createSignal } from "solid-js";
import type { DetectedCli } from "../ipc";
import { cliListAvailable } from "../ipc";

const [availableClis, setAvailableClis] = createSignal<DetectedCli[]>([]);
const [isClisLoading, setIsClisLoading] = createSignal(true);

export { availableClis, isClisLoading };

/**
 * Fetch the cached list of detected CLIs from the backend.
 *
 * This reads the registry that was scanned once at app boot time,
 * so it is fast and synchronous on the Rust side.
 */
export async function loadClis(): Promise<void> {
  setIsClisLoading(true);
  try {
    const clis = await cliListAvailable();
    setAvailableClis(clis);
  } catch (err) {
    console.error("Failed to load available CLIs:", err);
    setAvailableClis([]);
  } finally {
    setIsClisLoading(false);
  }
}
