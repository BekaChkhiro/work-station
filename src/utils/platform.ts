/**
 * Platform detection utilities for Tauri desktop apps.
 *
 * Uses navigator.platform / userAgent as a lightweight alternative to
 * the @tauri-apps/plugin-os dependency. These checks are sufficient for
 * UI chrome decisions (title bar, traffic-light padding).
 */

/** True when running on macOS (desktop, not iOS). */
export function isMac(): boolean {
  return /Mac/i.test(navigator.platform) && !/iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** True when running on Windows. */
export function isWindows(): boolean {
  return /Win/i.test(navigator.platform) || /Windows/i.test(navigator.userAgent);
}
