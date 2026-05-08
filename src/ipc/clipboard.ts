import { invoke } from "@tauri-apps/api/core";

export async function saveClipboardImage(base64: string): Promise<string> {
  return invoke<string>("save_clipboard_image", { data: base64 });
}
