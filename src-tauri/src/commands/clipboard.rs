use base64::{engine::general_purpose::STANDARD, Engine};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::command;

#[command]
pub fn save_clipboard_image(data: String) -> Result<String, String> {
    let bytes = STANDARD
        .decode(&data)
        .map_err(|e| format!("base64 decode failed: {e}"))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let path = std::env::temp_dir().join(format!("ws_screenshot_{ts}.png"));

    std::fs::write(&path, &bytes).map_err(|e| format!("write failed: {e}"))?;

    path.to_str()
        .map(std::string::ToString::to_string)
        .ok_or_else(|| "invalid path".to_string())
}
