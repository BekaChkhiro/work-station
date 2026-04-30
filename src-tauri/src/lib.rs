// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

pub mod commands;
pub mod db;
pub mod ipc;
pub mod pty;

use commands::{pty_get_scrollback, pty_info, pty_kill, pty_list, pty_resize, pty_spawn, pty_subscribe, pty_write};
use pty::PtyManager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(PtyManager::new())
        .invoke_handler(tauri::generate_handler![
            greet,
            pty_spawn,
            pty_list,
            pty_info,
            pty_subscribe,
            pty_write,
            pty_resize,
            pty_kill,
            pty_get_scrollback
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
